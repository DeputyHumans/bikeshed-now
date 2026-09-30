// SPDX-License-Identifier: Apache-2.0
// Creating a document and minting a version, shared by every publisher (SPEC §2, §11, §19).

/**
 * Why this module exists
 * ----------------------
 * There are four ways content enters this system — a browser upload, an in-app
 * commit, the publish CLI, and an MCP tool call — and they must agree on every
 * detail: the bundle framing, the hash, the dedup rule, the ordering of Storage
 * before Firestore, and what provenance is recorded.
 *
 * Three of the four run in this runtime, so they share this module rather than
 * reimplementing it. The fourth (`scripts/publish.mjs`) is ESM and cannot import
 * it; it is held in agreement by the golden-vector hash fixture and the
 * membership parity test instead.
 *
 * "The MCP server is a thin shell over the same logic the web app uses" is only
 * true if there is one implementation. This is it.
 */

import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import * as mime from "mime-types";
import { bucketName } from "../config";
import type { Actor } from "./actor";
import { hashBundleFiles, type BundleFile } from "./hash";
import type { BundleEntry } from "./bundle";
import { HEAD_SCAN_BYTES, titleFromHtml } from "./head";
import { renderMarkdown, titleFromMarkdown } from "./markdown/render";
import {
  computeDocMembership,
  slugify,
  uniqueDocId,
  type Membership,
} from "./folders";
import { syncPresenceAccess } from "./presence";
import { syncPublicProjection } from "./publicdoc";
import { resolveMarking, type Marking } from "./marking";

type Db = admin.firestore.Firestore;

const now = () => FieldValue.serverTimestamp();

export interface CompiledBundle {
  files: BundleFile[];
  entry: string;
  sourceEntry?: string;
  format: "html" | "markdown";
  rendererVersion?: string;
  title: string;
}

/**
 * Turn an extracted upload into the files that actually get stored.
 *
 * For Markdown that means compiling once, here, and storing BOTH the source and
 * the rendered entry inside the hashed bundle. Keeping both in the bundle is
 * what preserves content-hash idempotency — republishing identical Markdown is
 * still a no-op — while making a renderer upgrade correctly mint a new version,
 * because the artifact genuinely changed (SPEC §11).
 *
 * For HTML the default title is the document's own `<title>`, read from the
 * entry file, else `fallbackTitle`. An explicit title from the caller still
 * wins over either — that happens at the call site, which prefers a supplied
 * title over `compiled.title`.
 */
export function compileBundle(
  extracted: { files: BundleEntry[]; entry: string; format: "html" | "markdown" },
  fallbackTitle: string,
): CompiledBundle {
  const files: BundleFile[] = extracted.files.map((f) => ({
    rel: f.rel,
    data: f.data,
  }));
  if (extracted.format !== "markdown") {
    const entryFile = files.find((f) => f.rel === extracted.entry);
    // Only the prefix the scanner reads is decoded — the same bytes the
    // document page streams — rather than the whole entry, up to the upload cap.
    const title = entryFile
      ? (titleFromHtml(entryFile.data.subarray(0, HEAD_SCAN_BYTES).toString("utf8")) ?? fallbackTitle)
      : fallbackTitle;
    return { files, entry: extracted.entry, format: "html", title };
  }

  const source = files.find((f) => f.rel === extracted.entry);
  const markdown = source ? source.data.toString("utf8") : "";
  const title = titleFromMarkdown(markdown, fallbackTitle);
  const rendered = renderMarkdown(markdown, { title });
  const htmlRel = extracted.entry.replace(/\.(md|markdown)$/i, ".html");
  const entry = htmlRel === extracted.entry ? "index.html" : htmlRel;

  const withHtml = files.filter((f) => f.rel !== entry);
  withHtml.push({ rel: entry, data: Buffer.from(rendered.html, "utf8") });

  return {
    files: withHtml,
    entry,
    sourceEntry: extracted.entry,
    format: "markdown",
    rendererVersion: rendered.rendererVersion,
    title,
  };
}

/**
 * Write options that refuse to replace an object that already exists.
 *
 * A new document's bytes go in before its record does, so `currentVersion` can
 * never point at nothing. That leaves a window in which two creates hold the
 * same id. Without this the second one overwrites the first one's v1, bytes the
 * version record promises never change, and only then fails. No test can stage
 * the race on demand, so `wiring.test.js` pins that every new-document write
 * uses this.
 */
export const CREATE_ONLY = { preconditionOpts: { ifGenerationMatch: 0 } };

/** Storage's refusal of a CREATE_ONLY write: the object is already there. */
export function isPreconditionFailure(e: unknown): boolean {
  return (e as { code?: unknown } | null)?.code === 412;
}

/**
 * Allocate an id for a NEW document and put its v1 bytes there.
 *
 * `put` writes under the prefix it is given, CREATE_ONLY. If Storage refuses,
 * the id is in use even though no record says so yet: a create racing this
 * one, or bytes a failed create left behind. Both mean "taken", so the id gets
 * a random suffix and `put` runs once more.
 */
export async function placeNewDocument(
  db: Db,
  wanted: string,
  put: (storagePrefix: string) => Promise<void>,
): Promise<{ docId: string; storagePrefix: string }> {
  const docId = await uniqueDocId(db, wanted);
  try {
    await put(`docs/${docId}/v1`);
    return { docId, storagePrefix: `docs/${docId}/v1` };
  } catch (e) {
    if (!isPreconditionFailure(e)) throw e;
  }
  const retryId = await uniqueDocId(db, wanted, true);
  await put(`docs/${retryId}/v1`);
  return { docId: retryId, storagePrefix: `docs/${retryId}/v1` };
}

/** Upload every file of a bundle under a version prefix. */
async function uploadBundle(
  storagePrefix: string,
  files: readonly BundleFile[],
  preconditions: Partial<typeof CREATE_ONLY> = {},
): Promise<void> {
  const bucket = admin.storage().bucket(bucketName());
  for (const f of files) {
    await bucket.file(`${storagePrefix}/${f.rel}`).save(f.data, {
      contentType: mime.lookup(f.rel) || "application/octet-stream",
      resumable: false,
      ...preconditions,
    });
  }
}

export interface PublishInput {
  db: Db;
  actor: Actor;
  ownerEmail: string;
  ownerUid: string;
  compiled: CompiledBundle;
  title: string;
  folderId: string | null;
  parentMembership: Membership | null;
  marking?: unknown;
  /** How the content arrived. Recorded on the version and never client-claimed. */
  via: "upload" | "cli" | "mcp" | "api";
  /**
   * The id the publisher asked for, already checked with `isValidDocId`. If it
   * is taken the document still gets made, under a suffixed id; absent, the id
   * comes from the title.
   */
  docId?: string;
}

export interface PublishResult {
  docId: string;
  versionId: string;
  title: string;
  fileCount: number;
  bytes: number;
  format: "html" | "markdown";
}

/**
 * Create a NEW document at v1.
 *
 * `trusted: false` unconditionally: the publisher is not necessarily the author,
 * so the viewer sandboxes the bundle's scripts until somebody with standing says
 * otherwise. The OPERATOR script (`scripts/publish.mjs`) raises it separately
 * and deliberately, with Admin credentials (SPEC §6c).
 */
export async function publishNewDocument(
  input: PublishInput,
): Promise<PublishResult> {
  const { db, compiled } = input;
  const slug = slugify(input.title);
  const versionId = "v1";
  const { contentHash, fileCount, bytes } = hashBundleFiles(compiled.files);

  // Bytes first, then Firestore, so `currentVersion` can never point at a
  // version whose objects are missing.
  const { docId, storagePrefix } = await placeNewDocument(
    db,
    input.docId ?? slug,
    (prefix) => uploadBundle(prefix, compiled.files, CREATE_ONLY),
  );

  const membership = computeDocMembership(
    input.ownerEmail,
    [],
    [],
    input.parentMembership,
  );
  const marking: Marking = resolveMarking(input.marking);
  const docRef = db.collection("docs").doc(docId);

  const batch = db.batch();
  batch.create(docRef, {
    docId,
    title: input.title,
    slug,
    ownerUid: input.ownerUid,
    ownerEmail: input.ownerEmail,
    currentVersion: versionId,
    viewers: [],
    editors: [],
    members: membership.members,
    editorMembers: membership.editorMembers,
    folderId: input.folderId,
    visibility: "private",
    publicEdit: false,
    trusted: false,
    marking,
    createdAt: now(),
    updatedAt: now(),
  });
  batch.create(docRef.collection("versions").doc(versionId), {
    versionId,
    label: versionId,
    entry: compiled.entry,
    format: compiled.format,
    ...(compiled.sourceEntry ? { sourceEntry: compiled.sourceEntry } : {}),
    ...(compiled.rendererVersion ? { rendererVersion: compiled.rendererVersion } : {}),
    storagePrefix,
    fileCount,
    bytes,
    contentHash,
    files: compiled.files.map((f) => f.rel),
    parentVersion: null,
    publishedVia: input.via,
    publishedByEmail: input.ownerEmail,
    publishedBy: input.actor,
    publishedAt: now(),
  });
  await batch.commit();

  await syncPresenceAccess(docId, membership.members, membership.editorMembers);

  return {
    docId,
    versionId,
    title: input.title,
    fileCount,
    bytes,
    format: compiled.format,
  };
}

export interface UpdateResult {
  versionId: string;
  contentHash: string;
  fileCount: number;
  bytes: number;
  deduped: boolean;
}

/**
 * Mint a new version of an existing document from supplied content.
 *
 * Used by the agent surface, where the caller sends a whole new document rather
 * than editing a draft. The dedup rule is the same one the CLI and the in-app
 * commit use, which is what makes "publish the same thing twice" safe for an
 * agent that cannot remember whether it already did.
 */
export async function commitNewVersion(args: {
  db: Db;
  docRef: admin.firestore.DocumentReference;
  compiled: CompiledBundle;
  actor: Actor;
  authorEmail: string;
  baseVersion: string | null;
  via: "cli" | "mcp" | "api" | "editor" | "upload";
}): Promise<UpdateResult> {
  const { db, docRef, compiled } = args;
  const { contentHash, fileCount, bytes } = hashBundleFiles(compiled.files);
  const versionsRef = docRef.collection("versions");

  const dup = await versionsRef.where("contentHash", "==", contentHash).limit(1).get();
  if (!dup.empty) {
    return {
      versionId: dup.docs[0].id,
      contentHash,
      fileCount,
      bytes,
      deduped: true,
    };
  }

  const allVersions = await versionsRef.get();
  let maxN = 0;
  for (const d of allVersions.docs) {
    const m = /^v(\d+)$/.exec(d.id);
    if (m) maxN = Math.max(maxN, Number(m[1]));
  }
  const versionId = `v${maxN + 1}`;
  const storagePrefix = `docs/${docRef.id}/${versionId}`;
  await uploadBundle(storagePrefix, compiled.files);

  await db.runTransaction(async (tx) => {
    const vRef = versionsRef.doc(versionId);
    if ((await tx.get(vRef)).exists) throw new Error("CONFLICT");
    tx.set(vRef, {
      versionId,
      label: versionId,
      entry: compiled.entry,
      format: compiled.format,
      ...(compiled.sourceEntry ? { sourceEntry: compiled.sourceEntry } : {}),
      ...(compiled.rendererVersion
        ? { rendererVersion: compiled.rendererVersion }
        : {}),
      storagePrefix,
      fileCount,
      bytes,
      contentHash,
      files: compiled.files.map((f) => f.rel),
      parentVersion: args.baseVersion,
      publishedVia: args.via,
      publishedByEmail: args.authorEmail,
      publishedBy: args.actor,
      publishedAt: now(),
    });
    tx.set(
      docRef,
      {
        currentVersion: versionId,
        draft: FieldValue.delete(),
        updatedAt: now(),
        stats: {
          commits: FieldValue.increment(1),
          lastEditedAt: now(),
          lastEditedByEmail: args.authorEmail,
        },
      },
      { merge: true },
    );
  });

  await syncPublicProjection(db, docRef.id);

  return { versionId, contentHash, fileCount, bytes, deduped: false };
}
