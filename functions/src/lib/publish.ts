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
import { MAX_BUNDLE_BYTES, bucketName } from "../config";
import { emptyGrants } from "./access";
import type { Actor } from "./actor";
import { hashBundleFiles, type BundleFile } from "./hash";
import { safeBundleRelPath, type BundleEntry, type ExtractedBundle } from "./bundle";
import { HEAD_SCAN_BYTES, titleFromHtml } from "./head";
import { renderMarkdown, titleFromMarkdown } from "./markdown/render";
import {
  computeDocMembership,
  slugify,
  uniqueDocId,
  type Membership,
} from "./folders";
import { syncPresenceAccess } from "./presence";
import { anyOpenThread, refuseIfPending, type PendingRefusal } from "./review";

/** Another version became current while this one was uploading. */
export interface StaleRefusal {
  error: string;
  status: 409;
  currentVersion: string;
}
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

/** What an update is laid over: the current version's files and where its entry is. */
export interface BaseBundle {
  files: BundleFile[];
  entry: string;
  sourceEntry?: string;
  format: "html" | "markdown";
}

const FORMAT_NAME = { html: "HTML", markdown: "Markdown" } as const;

/**
 * The files a new version holds when an update arrives through a token.
 *
 * The in-app commit has always laid the edited entry over the base version's
 * files (SPEC §2, `POST /commit`). Updates through a token built the version
 * from the sent file alone, so the first revision of a bundle dropped every
 * image and stylesheet beside its entry. They follow the commit's rule now:
 *
 *   - A `.zip` is the whole new bundle. A file it leaves out is gone.
 *   - One file replaces the ENTRY, at the base version's own path, and every
 *     other file is carried forward. The base's path rather than `index.*`,
 *     so a nested entry's relative references still resolve and the old entry
 *     does not survive beside the new one.
 *
 * The format is the document's. Converting between Markdown and HTML is not
 * something an update should do as a side effect of a file extension.
 */
export function compileRevision(
  base: BaseBundle,
  extracted: ExtractedBundle,
  fallbackTitle: string,
  maxBytes: number,
): CompiledBundle | { error: string } {
  if (extracted.format !== base.format) {
    return {
      error: `this document is ${FORMAT_NAME[base.format]}, so an update to it cannot be ${FORMAT_NAME[extracted.format]}`,
    };
  }
  if (extracted.archive) return withinCap(compileBundle(extracted, fallbackTitle), maxBytes);

  const at = base.sourceEntry ?? (base.format === "markdown" ? "index.md" : base.entry);
  const sent = extracted.files.find((f) => f.rel === extracted.entry);
  const compiled = compileBundle(
    { files: [{ rel: at, data: sent?.data ?? Buffer.alloc(0) }], entry: at, format: extracted.format },
    fallbackTitle,
  );
  const byRel = new Map<string, Buffer>();
  for (const f of base.files) byRel.set(f.rel, f.data);
  for (const f of compiled.files) byRel.set(f.rel, f.data);
  const files = [...byRel].map(([rel, data]) => ({ rel, data }));
  return withinCap({ ...compiled, files }, maxBytes);
}

function withinCap(compiled: CompiledBundle, maxBytes: number): CompiledBundle | { error: string } {
  const total = compiled.files.reduce((n, f) => n + f.data.length, 0);
  return total > maxBytes ? { error: "bundle is too large" } : compiled;
}

/** Every object under a Storage prefix, as in-memory bundle files. */
export async function readPrefix(prefix: string): Promise<BundleFile[]> {
  const [objects] = await admin.storage().bucket(bucketName()).getFiles({ prefix });
  const files: BundleFile[] = [];
  for (const obj of objects) {
    const rel = obj.name.slice(prefix.length);
    if (rel.length === 0 || rel.endsWith("/")) continue;
    const [data] = await obj.download();
    files.push({ rel, data });
  }
  return files;
}

/**
 * Mint a new version of an existing document from an update.
 *
 * The one implementation behind `update_document` and `POST /publish?update=`,
 * so an update means the same thing whichever way it arrives. The caller has
 * already decided the caller may write; this decides what the version holds.
 */
export async function reviseDocument(args: {
  db: Db;
  docRef: admin.firestore.DocumentReference;
  baseVersion: string;
  title: string;
  extracted: ExtractedBundle;
  actor: Actor;
  authorEmail: string;
  via: "cli" | "mcp" | "api" | "upload";
}): Promise<UpdateResult | PendingRefusal | StaleRefusal | { error: string }> {
  const { docRef, baseVersion, extracted } = args;
  const snap = baseVersion ? await docRef.collection("versions").doc(baseVersion).get() : null;
  const v = snap?.exists ? snap.data() ?? {} : null;
  const entry = typeof v?.entry === "string" ? safeBundleRelPath(v.entry) : null;
  if (!v || !entry) return { error: "this document has no current version to update" };

  const sourceEntry = typeof v.sourceEntry === "string" ? safeBundleRelPath(v.sourceEntry) : null;
  const base: BaseBundle = {
    entry,
    format: v.format === "markdown" ? "markdown" : "html",
    ...(sourceEntry ? { sourceEntry } : {}),
    // An archive replaces everything, so the base's bytes are not read for it.
    files: extracted.archive ? [] : await readPrefix(`docs/${docRef.id}/${baseVersion}/`),
  };

  const compiled = compileRevision(base, extracted, args.title, MAX_BUNDLE_BYTES);
  if ("error" in compiled) return compiled;
  return commitNewVersion({
    db: args.db,
    docRef,
    compiled,
    actor: args.actor,
    authorEmail: args.authorEmail,
    baseVersion,
    via: args.via,
  });
}

/**
 * Every reader's own trust grant on a document (`docs/{docId}/trust/{uid}`).
 *
 * Read inside the transaction that mints a version, because a transaction
 * reads before it writes, and so that the grants withdrawn are exactly the
 * ones that existed when the version became current.
 */
export async function readTrustGrants(
  tx: admin.firestore.Transaction,
  docRef: admin.firestore.DocumentReference,
): Promise<admin.firestore.DocumentReference[]> {
  const snap = await tx.get(docRef.collection("trust"));
  return snap.docs.map((d) => d.ref);
}

/**
 * Withdraw every vouch for a document's scripts: the owner's, for everyone,
 * and each reader's own. A reader trusted the scripts they had seen, not
 * whatever somebody publishes next, so personal trust goes with global trust.
 */
export function withdrawTrust(
  tx: admin.firestore.Transaction,
  docRef: admin.firestore.DocumentReference,
  grants: readonly admin.firestore.DocumentReference[],
): void {
  tx.set(docRef, { trusted: false }, { merge: true });
  for (const grant of grants) tx.delete(grant);
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
    emptyGrants(),
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
    ...emptyGrants(),
    ...membership,
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
 *
 * A new version through here is an upload, so it is never trusted: the owner's
 * trust and every reader's own are withdrawn with the same write that makes it
 * current (SPEC §6c). A deduplicated update changes nothing and keeps them.
 */
export async function commitNewVersion(args: {
  db: Db;
  docRef: admin.firestore.DocumentReference;
  compiled: CompiledBundle;
  actor: Actor;
  authorEmail: string;
  baseVersion: string | null;
  via: "cli" | "mcp" | "api" | "editor" | "upload";
}): Promise<UpdateResult | PendingRefusal | StaleRefusal> {
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

  // After the dedup above, so an identical update stays a no-op whatever is
  // pending, and before anything is uploaded, so a refusal leaves no bytes.
  const refused = await refuseIfPending(docRef, args.baseVersion ?? "");
  if (refused) return refused;

  const allVersions = await versionsRef.get();
  let maxN = 0;
  for (const d of allVersions.docs) {
    const m = /^v(\d+)$/.exec(d.id);
    if (m) maxN = Math.max(maxN, Number(m[1]));
  }
  const versionId = `v${maxN + 1}`;
  const storagePrefix = `docs/${docRef.id}/${versionId}`;
  await uploadBundle(storagePrefix, compiled.files);

  const base = args.baseVersion ?? "";
  try {
    await db.runTransaction(async (tx) => {
      // Both asked again here, where the version becomes current: the checks
      // above ran before the upload, and either may have changed during it.
      const cur = await tx.get(docRef);
      if (base && cur.data()?.currentVersion !== base) throw new Error("STALE");
      if (await anyOpenThread(tx, docRef, base, "suggestions")) throw new Error("PENDING");
      await mintVersion(tx);
    });
  } catch (e) {
    const reason = (e as Error).message;
    if (reason === "PENDING") {
      const pending = await refuseIfPending(docRef, base);
      if (pending) return pending;
    }
    if (reason === "STALE" || reason === "PENDING") {
      const fresh = await docRef.get();
      return {
        error: "Somebody published a newer version while this one was uploading. Read it, then update it again.",
        status: 409,
        currentVersion: String(fresh.data()?.currentVersion ?? ""),
      };
    }
    throw e;
  }

  await syncPublicProjection(db, docRef.id);

  return { versionId, contentHash, fileCount, bytes, deduped: false };

  async function mintVersion(tx: admin.firestore.Transaction): Promise<void> {
    const vRef = versionsRef.doc(versionId);
    if ((await tx.get(vRef)).exists) throw new Error("CONFLICT");
    const grants = await readTrustGrants(tx, docRef);
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
    withdrawTrust(tx, docRef, grants);
  }
}
