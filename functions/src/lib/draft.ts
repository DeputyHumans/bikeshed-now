// SPDX-License-Identifier: Apache-2.0
// The shared draft: writing it, reading it back, and publishing it as a version (SPEC §6a).

import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { newBundlePrefix, versionStoragePrefix } from "./storage";
import * as mime from "mime-types";
import { MAX_BUNDLE_BYTES, bucketName } from "../config";
import { keepsTrust, type DocAclData } from "./acl";
import { isAutomated, type Actor } from "./actor";
import { hashBundleFiles, type BundleFile } from "./hash";
import { safeRelPath } from "./http";
import { renderMarkdown } from "./markdown/render";
import { readPrefix, readTrustGrants, withdrawTrust } from "./publish";
import { syncPublicProjection } from "./publicdoc";
import { anyOpenThread, pendingSuggestions, pendingSuggestionsMessage } from "./review";

/**
 * The browser's editor and the agent surface both change a document through
 * its draft: the app by autosave, an agent by accepting a suggestion. Both
 * publish it the same way, by promoting the draft to a version. One copy of
 * each step, here, is what keeps the two from drifting (SPEC §6a, §22).
 */

type Db = admin.firestore.Firestore;
type DocRef = admin.firestore.DocumentReference;

const now = () => FieldValue.serverTimestamp();
const bucket = () => admin.storage().bucket(bucketName());

export interface VersionMeta {
  entry: string;
  format: "html" | "markdown";
  sourceEntry?: string;
  storagePrefix?: string;
}

export async function loadVersionMeta(docRef: DocRef, versionId: string): Promise<VersionMeta | null> {
  const snap = await docRef.collection("versions").doc(versionId).get();
  if (!snap.exists) return null;
  const v = snap.data() || {};
  const entry = typeof v.entry === "string" ? safeRelPath(v.entry) : null;
  if (!entry) return null;
  return {
    entry,
    storagePrefix: versionStoragePrefix(docRef.id, versionId, v),
    format: v.format === "markdown" ? "markdown" : "html",
    sourceEntry: typeof v.sourceEntry === "string" ? (safeRelPath(v.sourceEntry) ?? undefined) : undefined,
  };
}

export type EditSession = { email: string; actor: Actor; from: number; to: number };

/**
 * Append this editor to the draft's session log, or extend their open entry.
 *
 * Derived from actual saves rather than from lock transitions, which is both
 * simpler and better evidence: the lock says who HELD the right to edit, the
 * saves say who actually wrote. When the lock changes hands twice in one draft,
 * `lastEditedByEmail` alone cannot answer "who wrote v3" — this can (SPEC §17).
 */
export function appendEditSession(existing: unknown, actor: Actor): EditSession[] {
  const list = Array.isArray(existing) ? (existing as EditSession[]) : [];
  const stamp = Date.now();
  const last = list[list.length - 1];
  if (last && last.email === actor.email && last.actor?.channel === actor.channel) {
    last.to = stamp;
    return list.slice(-50);
  }
  return [...list, { email: actor.email, actor, from: stamp, to: stamp }].slice(-50);
}

/** What a draft holds: an HTML entry, or a Markdown source and its rendering. */
export type DraftContent = { html: string } | { markdown: string; html: string };

/**
 * Store `content` as the draft of `baseVersion`, which the caller has checked
 * is current, and record who wrote it. For Markdown both files are written:
 * the source, which is canonical, and its rendering, so a read-back of the
 * draft needs no special case (SPEC §11).
 */
export async function writeDraft(args: {
  docRef: DocRef;
  baseVersion: string;
  version: VersionMeta;
  content: DraftContent;
  existingSessions: unknown;
  emailLower: string;
  actor: Actor;
}): Promise<Record<string, unknown>> {
  const { docRef, baseVersion, version, content } = args;
  const prefix = `docs/${docRef.id}/draft/`;
  let bytes = 0;
  let sourceEntry: string | undefined;

  if ("markdown" in content) {
    sourceEntry = version.sourceEntry ?? "index.md";
    await bucket()
      .file(`${prefix}${sourceEntry}`)
      .save(Buffer.from(content.markdown, "utf8"), {
        contentType: "text/markdown; charset=utf-8",
        resumable: false,
      });
    await bucket()
      .file(`${prefix}${version.entry}`)
      .save(Buffer.from(content.html, "utf8"), { contentType: "text/html; charset=utf-8", resumable: false });
    bytes = Buffer.byteLength(content.markdown, "utf8");
  } else {
    const htmlBuf = Buffer.from(content.html, "utf8");
    await bucket()
      .file(`${prefix}${version.entry}`)
      .save(htmlBuf, { contentType: "text/html; charset=utf-8", resumable: false });
    bytes = htmlBuf.length;
  }

  const draft = {
    baseVersion,
    entry: version.entry,
    ...(sourceEntry ? { sourceEntry } : {}),
    bytes,
    updatedByEmail: args.emailLower,
    editSessions: appendEditSession(args.existingSessions, args.actor),
  };
  await docRef.set(
    {
      draft: { ...draft, updatedAt: now() },
      updatedAt: now(),
      // Edit provenance, folded into a write that was happening anyway. The
      // draft is cleared on commit, so without this the "last edited by" signal
      // would vanish the moment a version is published. A nested map under
      // set/merge deep-merges, leaving the view counters alone.
      stats: { lastEditedAt: now(), lastEditedByEmail: args.emailLower },
    },
    { merge: true },
  );
  return draft;
}

/** The first of these objects that exists, as text, or null. */
async function readFirst(keys: string[]): Promise<string | null> {
  for (const key of keys) {
    try {
      const [bytes] = await bucket().file(key).download();
      return bytes.toString("utf8");
    } catch {
      /* not there; the next place, or nothing */
    }
  }
  return null;
}

export type WorkingCopy = {
  baseVersion: string;
  version: VersionMeta;
} & ({ format: "html"; html: string } | { format: "markdown"; markdown: string });

/**
 * The document as an editor would open it now: the draft of the current
 * version where there is one, the current version where there is not. What
 * an accepted suggestion is applied to, so it lands on top of whatever the
 * draft already holds rather than replacing it. For Markdown, the source.
 */
export async function readWorkingCopy(
  docRef: DocRef,
  data: { currentVersion?: unknown; draft?: { baseVersion?: unknown } | null },
): Promise<WorkingCopy | null> {
  const baseVersion = String(data.currentVersion ?? "");
  const version = baseVersion ? await loadVersionMeta(docRef, baseVersion) : null;
  if (!version) return null;
  // A draft of an older version is not the working copy of this one.
  const hasDraft = data.draft?.baseVersion === baseVersion;
  const read = (rel: string) =>
    readFirst([
      ...(hasDraft ? [`docs/${docRef.id}/draft/${rel}`] : []),
      `${version.storagePrefix}/${rel}`,
    ]);
  if (version.format === "markdown") {
    const markdown = await read(version.sourceEntry ?? "index.md");
    return markdown == null ? null : { baseVersion, version, format: "markdown", markdown };
  }
  const html = await read(version.entry);
  return html == null ? null : { baseVersion, version, format: "html", html };
}

/**
 * Why a new version cannot be published over `baseVersion` yet, or null. A
 * pending suggestion is an open thread too, so it is in the count; which kind
 * it is decides who can clear it — anyone resolves a comment, and only an
 * approver decides a suggestion — so the refusal says which.
 */
export async function openThreadsRefusal(
  docRef: DocRef,
  baseVersion: string,
): Promise<{ error: string; unresolvedCount: number; pendingSuggestions: number } | null> {
  const unresolved = await docRef
    .collection("versions")
    .doc(baseVersion)
    .collection("annotations")
    .where("resolved", "==", false)
    .count()
    .get();
  const unresolvedCount = unresolved.data().count;
  if (unresolvedCount === 0) return null;
  const pending = await pendingSuggestions(docRef, baseVersion);
  return {
    error: pending > 0 ? pendingSuggestionsMessage(pending) : "Resolve all comments before publishing a new version.",
    unresolvedCount,
    pendingSuggestions: pending,
  };
}

export type CommitOutcome = { status: 200 | 409; body: Record<string, unknown> };

/**
 * Promote the draft of `baseVersion` into a new immutable version, for a
 * caller the endpoint or tool has already allowed to edit a document that has
 * not expired and whose current version is `baseVersion`.
 *
 * Mirrors the publish CLI exactly: assemble, hash with the frozen framing,
 * DEDUP on contentHash, upload, then one transaction that writes the version and
 * moves the pointer. Identical bytes are a no-op, which is what makes publishing
 * safe to retry and safe for an agent that cannot remember what it already did.
 */
export async function commitDraft(args: {
  db: Db;
  docRef: DocRef;
  baseVersion: string;
  draft: { entry?: unknown; editSessions?: unknown } | null | undefined;
  emailLower: string;
  actor: Actor;
}): Promise<CommitOutcome> {
  const { db, docRef, baseVersion, draft, actor } = args;
  const docId = docRef.id;
  if (!draft || typeof draft.entry !== "string") {
    return { status: 409, body: { error: "There is no draft to publish." } };
  }

  // No new version while comments on the current one are open. Annotations are
  // version-scoped, so publishing would leave them behind on a version nobody
  // is reading any more. Asked here, before any bytes are uploaded, and again
  // inside the transaction that makes the new version current.
  const open = await openThreadsRefusal(docRef, baseVersion);
  if (open) return { status: 409, body: open };

  const version = await loadVersionMeta(docRef, baseVersion);
  if (!version) return { status: 409, body: { error: "the base version is missing" } };

  // Assemble: base assets, with anything the draft carries overriding it. That
  // one rule covers both formats — for Markdown the draft carries index.md and
  // index.html, for HTML just the entry — with no branch here.
  const basePrefix = `${version.storagePrefix}/`;
  const draftPrefix = `docs/${docId}/draft/`;
  const baseFiles = await readPrefix(basePrefix);
  const draftFiles = await readPrefix(draftPrefix);
  const byRel = new Map<string, Buffer>();
  for (const f of baseFiles) byRel.set(f.rel, f.data);
  for (const f of draftFiles) byRel.set(f.rel, f.data);
  const files: BundleFile[] = [...byRel].map(([rel, data]) => ({ rel, data }));
  const totalBytes = files.reduce((n, f) => n + f.data.length, 0);
  if (totalBytes > MAX_BUNDLE_BYTES) return { status: 409, body: { error: "bundle too large to publish" } };
  if (files.length === 0) return { status: 409, body: { error: "base version has no content to publish" } };

  const { contentHash, fileCount, bytes } = hashBundleFiles(files);
  const versionsRef = docRef.collection("versions");

  const dup = await versionsRef.where("contentHash", "==", contentHash).limit(1).get();
  if (!dup.empty) {
    await docRef.set({ draft: FieldValue.delete(), updatedAt: now() }, { merge: true });
    await bucket().deleteFiles({ prefix: draftPrefix, force: true });
    return {
      status: 200,
      body: { versionId: dup.docs[0].id, contentHash, fileCount, bytes, deduped: true },
    };
  }

  // Version ids mint as max(N)+1 over EXISTING version documents, so a
  // withdrawn id is re-used by the next commit. That is deliberate; the view
  // tombstone in delete-version.mjs is what keeps the two from being conflated.
  const allVersions = await versionsRef.get();
  let maxN = 0;
  for (const d of allVersions.docs) {
    const m = /^v(\d+)$/.exec(d.id);
    if (m) maxN = Math.max(maxN, Number(m[1]));
  }
  const versionId = `v${maxN + 1}`;
  const storagePrefix = newBundlePrefix(docId);

  for (const f of files) {
    await bucket().file(`${storagePrefix}/${f.rel}`).save(f.data, {
      contentType: mime.lookup(f.rel) || "application/octet-stream",
      resumable: false,
      preconditionOpts: { ifGenerationMatch: 0 },
    });
  }

  const editSessions = Array.isArray(draft.editSessions) ? draft.editSessions : [];

  try {
    await db.runTransaction(async (tx) => {
      const cur = await tx.get(docRef);
      if ((cur.data()?.currentVersion as string) !== baseVersion) throw new Error("STALE");
      if (await anyOpenThread(tx, docRef, baseVersion, "threads")) throw new Error("OPEN");
      const vRef = versionsRef.doc(versionId);
      if ((await tx.get(vRef)).exists) throw new Error("CONFLICT");
      // Trust carries into the new version only when its owner wrote it here.
      // The server stores whatever HTML a draft is sent, so "in-app editing
      // cannot add a script" was never true of anybody else's edit (SPEC §6c).
      const keeps = keepsTrust(cur.data() as DocAclData, {
        emailLower: args.emailLower,
        channel: actor.channel,
      });
      const grants = keeps ? [] : await readTrustGrants(tx, docRef);
      tx.set(vRef, {
        versionId,
        label: versionId,
        entry: version.entry,
        format: version.format,
        ...(version.sourceEntry ? { sourceEntry: version.sourceEntry } : {}),
        ...(version.format === "markdown" ? { rendererVersion: renderMarkdown("", {}).rendererVersion } : {}),
        storagePrefix,
        fileCount,
        bytes,
        contentHash,
        files: files.map((f) => f.rel),
        parentVersion: baseVersion,
        publishedVia: isAutomated(actor) ? actor.channel : "editor",
        publishedByEmail: args.emailLower,
        publishedBy: actor,
        editSessions,
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
            lastEditedByEmail: args.emailLower,
          },
        },
        { merge: true },
      );
      if (!keeps) withdrawTrust(tx, docRef, grants);
    });
  } catch (e) {
    const reason = (e as Error).message;
    if (reason === "OPEN") {
      // Opened while the bytes were uploading: refused as it would have been before.
      const open = await openThreadsRefusal(docRef, baseVersion);
      if (open) return { status: 409, body: open };
    }
    if (reason === "STALE" || reason === "CONFLICT" || reason === "OPEN") {
      const fresh = await docRef.get();
      return {
        status: 409,
        body: {
          error: "Another editor just published. Reload before publishing.",
          currentVersion: fresh.data()?.currentVersion,
        },
      };
    }
    throw e;
  }

  await bucket().deleteFiles({ prefix: draftPrefix, force: true });
  await syncPublicProjection(db, docId);

  return { status: 200, body: { versionId, contentHash, fileCount, bytes, deduped: false } };
}
