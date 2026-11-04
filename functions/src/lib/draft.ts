// SPDX-License-Identifier: Apache-2.0
// The shared draft: writing it, reading it back, and publishing it as a version (SPEC §6a).

import * as admin from "firebase-admin";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { causalOrder, readStoredCausalStamp, storedCausalStamp, type CausalStamp } from "./causal";
import { clearEditLog, syncPresenceAccess } from "./presence";
import { FieldValue } from "firebase-admin/firestore";
import { newBundlePrefix, versionStoragePrefix } from "./storage";
import { assertDocumentWriteAuthority, assertWriteAuthority, WriteAuthorityError } from "./writeAuthority";
import * as mime from "mime-types";
import { MAX_BUNDLE_BYTES, bucketName } from "../config";
import { type DocAclData } from "./acl";
import type { Actor } from "./actor";
import { publishedViaOf } from "./versions";
import { hashBundleFiles, type BundleFile } from "./hash";
import { safeRelPath } from "./http";
import { renderMarkdown } from "./markdown/render";
import { readPrefix, readTrustGrants, withdrawTrust } from "./publish";
import { syncPublicProjection } from "./publicdoc";
import { anyOpenThread, pendingSuggestions, pendingSuggestionsMessage } from "./review";
import { clearReceipt, freshReceiptId, readReceipt, recordReceipt } from "./transaction-receipts";

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
  // One entry per credential, not per channel: two agents of one person, on
  // two tokens, are two entries.
  if (last && last.email === actor.email && last.actor?.channel === actor.channel && last.actor?.tokenId === actor.tokenId) {
    last.to = stamp;
    return list.slice(-50);
  }
  return [...list, { email: actor.email, actor, from: stamp, to: stamp }].slice(-50);
}

/** What a draft holds: an HTML entry, or a Markdown source and its rendering. */
export type DraftContent = { html: string } | { markdown: string; html: string };

/** Identifies the exact draft a reader observed, including legacy timestamped drafts. */
export function draftIdentity(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const draft = value as Record<string, unknown>;
  if (typeof draft.storagePrefix === "string") return draft.storagePrefix;
  return JSON.stringify([draft.baseVersion, draft.entry, draft.updatedAt ?? null]);
}

/** An opaque identity for the exact immutable bytes a browser was offered. */
export function draftRevision(data: { currentVersion?: unknown; draft?: unknown }): string {
  return createHash("sha256").update(JSON.stringify([data.currentVersion ?? null, draftIdentity(data.draft)])).digest("hex");
}

export class DraftConflict extends Error {
  constructor(readonly detail: Record<string, unknown>) {
    super(String(detail.error));
    this.name = "DraftConflict";
  }
}

function checkDraftBase(data: Record<string, unknown> | undefined, base: string): void {
  if (data?.currentVersion !== base) throw new DraftConflict({
    error: "This document has a newer version. Reload before editing.",
    currentVersion: data?.currentVersion ?? "",
  });
}

function checkDraftSnapshot(data: Record<string, unknown> | undefined, expected: unknown): void {
  if (draftIdentity(data?.draft) !== draftIdentity(expected)) throw new DraftConflict({
    error: "The draft changed while this request was running. Retry with the current draft.",
    draftChanged: true,
  });
}

/** Delete only the snapshot a completed operation replaced, never a newer save. */
export async function removeDraftSnapshot(docId: string, draft: unknown): Promise<void> {
  if (!draft || typeof draft !== "object") return;
  const prefix = `${versionStoragePrefix(docId, "draft", draft)}/`;
  try { await bucket().deleteFiles({ prefix, force: true }); }
  catch { console.error("could not remove a replaced draft snapshot"); }
}

/** After a known refusal, prove an attempted upload is absent from every durable pointer. */
export async function removeUnreferencedCandidate(db: Db, docRef: DocRef, storagePrefix: string): Promise<void> {
  try {
    const unreferenced = await db.runTransaction(async (tx) => {
      const current = await tx.get(docRef);
      const versions = await tx.get(docRef.collection("versions"));
      return current.data()?.draft?.storagePrefix !== storagePrefix
        && !versions.docs.some((version) => version.data().storagePrefix === storagePrefix);
    });
    // This request alone allocated the unpredictable prefix. Once its write
    // attempt has terminally refused, no other operation can introduce it as
    // a new pointer; later edits and publications allocate their own prefixes.
    if (unreferenced) await removeDraftSnapshot(docRef.id, { storagePrefix });
  } catch {
    // Failed reference reads are not proof that possibly committed bytes are unused.
    console.error("could not prove an unused upload candidate");
  }
}

/** Publish the new access fence before deleting only the retired session's log. */
export async function retireLiveSession(db: Db, docId: string, retiredEpoch: string): Promise<void> {
  await syncPresenceAccess(docId, [], []);
  try { await syncPublicProjection(db, docId); }
  catch {
    // The content write is already committed. Its Firestore trigger retries
    // projection repair; retain the old log until that metadata is current.
    console.error("could not refresh the retired live session projection");
    return;
  }
  try { await clearEditLog(docId, retiredEpoch); }
  catch { console.error("could not remove a retired live session"); }
}

/**
 * Store `content` as the draft of `baseVersion`, which the caller has checked
 * is current, and record who wrote it. For Markdown both files are written:
 * the source, which is canonical, and its rendering, so a read-back of the
 * draft needs no special case (SPEC §11).
 */
export async function writeDraft(args: {
  db: Db;
  docRef: DocRef;
  baseVersion: string;
  version: VersionMeta;
  content: DraftContent;
  expectedDraft?: unknown;
  expectedRevision?: string;
  liveEpoch?: string;
  causal?: CausalStamp;
  retireLive?: boolean;
  emailLower: string;
  actor: Actor;
}): Promise<Record<string, unknown>> {
  const { docRef, baseVersion, version, content } = args;
  const storagePrefix = newBundlePrefix(docRef.id);
  const prefix = `${storagePrefix}/`;
  let bytes = 0;
  let sourceEntry: string | undefined;

  if ("markdown" in content) {
    sourceEntry = version.sourceEntry ?? "index.md";
    await bucket()
      .file(`${prefix}${sourceEntry}`)
      .save(Buffer.from(content.markdown, "utf8"), {
        contentType: "text/markdown; charset=utf-8",
        resumable: false,
        preconditionOpts: { ifGenerationMatch: 0 },
      });
    await bucket()
      .file(`${prefix}${version.entry}`)
      .save(Buffer.from(content.html, "utf8"), { contentType: "text/html; charset=utf-8", resumable: false, preconditionOpts: { ifGenerationMatch: 0 } });
    bytes = Buffer.byteLength(content.markdown, "utf8");
  } else {
    const htmlBuf = Buffer.from(content.html, "utf8");
    await bucket()
      .file(`${prefix}${version.entry}`)
      .save(htmlBuf, { contentType: "text/html; charset=utf-8", resumable: false, preconditionOpts: { ifGenerationMatch: 0 } });
    bytes = htmlBuf.length;
  }

  let previous: unknown;
  let retiredEpoch: string | undefined;
  let reused = false;
  let candidateMayHaveCommitted = false;
  let transactionCandidateStaged = false;
  const linkSave = freshReceiptId();
  let savedEpoch = "initial";
  let draft: Record<string, unknown> = {};
  const caller = { uid: args.actor.uid ?? "", emailLower: args.emailLower };
  const acknowledgeOwnCandidate = (current: admin.firestore.DocumentData | undefined): boolean => {
    if (!candidateMayHaveCommitted || current?.draft?.storagePrefix !== storagePrefix) return false;
    draft = current.draft;
    savedEpoch = String(current.liveEpoch ?? "initial");
    reused = false;
    return true;
  };
  // Both commit paths call this with a freshly authorized snapshot. Never
  // carry a previous attempt's base, epoch, draft identity or causal decision.
  const prepare = (current: admin.firestore.DocumentData | undefined): Record<string, unknown> | null => {
    if ("expectedDraft" in args) checkDraftSnapshot(current, args.expectedDraft);
    if (args.expectedRevision !== undefined && draftRevision(current ?? {}) !== args.expectedRevision) throw new DraftConflict({
      error: "Someone saved a newer draft. Reload to read their changes before editing again.", draftChanged: true, reloadRequired: true,
    });
    const epoch = String(current?.liveEpoch ?? "initial");
    if (args.liveEpoch !== undefined && args.liveEpoch !== epoch) throw new DraftConflict({
      error: "This live editing session has been replaced. Reload to continue editing.", liveReset: true,
    });
    reused = false;
    savedEpoch = epoch;
    retiredEpoch = undefined;
    const currentCausal = readStoredCausalStamp(current?.draft?.causal);
    if (args.causal && currentCausal) {
      const order = causalOrder(args.causal, currentCausal);
      if (order === "generation") throw new DraftConflict({
        error: "This live editing session has been replaced. Reload to continue editing.", liveReset: true,
      });
      if (order === "concurrent") throw new DraftConflict({
        error: "Other edits are still arriving. Keep this editor open and retry saving after they merge.", draftChanged: true,
      });
      if (order === "behind" || order === "same") {
        draft = current!.draft;
        reused = true;
        return null;
      }
    }
    previous = current?.draft;
    if (args.retireLive) retiredEpoch = epoch;
    savedEpoch = args.retireLive ? randomUUID() : epoch;
    draft = {
      baseVersion, storagePrefix, entry: version.entry,
      ...(args.causal ? { causal: storedCausalStamp(args.causal) } : {}),
      ...(sourceEntry ? { sourceEntry } : {}), bytes,
      updatedByEmail: args.emailLower,
      editSessions: appendEditSession(current?.draft?.editSessions, args.actor),
    };
    return {
      draft: { ...draft, updatedAt: now() }, updatedAt: now(),
      ...(args.retireLive ? { liveEpoch: savedEpoch } : {}),
      "stats.lastEditedAt": now(), "stats.lastEditedByEmail": args.emailLower,
    };
  };
  try {
    // Read/write transactions acquire shared read locks before upgrading them
    // to write locks. Simultaneous autosaves can exhaust all SDK retries in
    // that upgrade cycle. A conditional write checks this same snapshot
    // atomically, without retaining a read lock while other writers arrive.
    const deadline = Date.now() + 10_000;
    const contended = () => new DraftConflict({
      error: "Other edits are still arriving. Keep this editor open and retry saving.", draftChanged: true,
    });
    let attempt = 0;
    for (;;) {
      const snap = await docRef.get();
      const current = snap.data();
      // A conditional SDK commit can succeed, lose its acknowledgement, and
      // then fail its internal retry's precondition. Our unique prefix proves
      // that outcome before a retired epoch or later role change can refuse it.
      if (acknowledgeOwnCandidate(current)) break;
      if (Date.now() >= deadline) throw contended();
      checkDraftBase(current, baseVersion);
      if (!assertDocumentWriteAuthority(current as DocAclData, caller)) {
        // Remembered link grants live in another document. Keep their read
        // in a real transaction so revocation races still refuse the write.
        // Its existing SDK retry duration is separate from the CAS deadline.
        await args.db.runTransaction(async (tx) => {
          const fresh = await tx.get(docRef);
          if (readReceipt<boolean>(fresh, linkSave).found) return;
          const data = fresh.data();
          checkDraftBase(data, baseVersion);
          await assertWriteAuthority(tx, docRef, data as DocAclData, caller);
          const update = prepare(data);
          if (update) {
            tx.update(docRef, update);
            recordReceipt(tx, docRef, fresh, linkSave, true);
            // The SDK can retry this callback after a committed transaction
            // loses its acknowledgement. A later refusal cannot disprove it.
            candidateMayHaveCommitted = true;
            transactionCandidateStaged = true;
          }
        });
        break;
      }
      const update = prepare(current);
      if (!update) break;
      if (!snap.updateTime) throw new Error("Draft snapshot has no update time.");
      try {
        await docRef.update(update, { lastUpdateTime: snap.updateTime });
        break;
      } catch (error) {
        // Only retry an explicit precondition/missing-document refusal. SDK
        // internal transport retries mean it does NOT prove the first commit
        // was absent. Reconcile our unique prefix and retain unresolved bytes.
        const code = (error as { code?: unknown }).code;
        if (code !== 5 && code !== 9) throw error;
        candidateMayHaveCommitted = true;
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          if (acknowledgeOwnCandidate((await docRef.get()).data())) break;
          throw contended();
        }
        // Exponential backoff with +/-50% jitter avoids a herd of immediate
        // re-reads. Keep the retry deadline independent of the attempt count.
        const basePause = Math.min(2_000, 250 * 1.5 ** Math.min(attempt++, 6));
        const pause = Math.min(remaining, Math.floor(basePause * (0.5 + Math.random())));
        await delay(pause);
        if (Date.now() >= deadline) {
          if (acknowledgeOwnCandidate((await docRef.get()).data())) break;
          throw contended();
        }
      }
    }
  } catch (error) {
    // A transaction or conditional-write retry may refuse after an earlier
    // commit lost its ACK. Prove no durable pointer selects its candidate
    // before deleting; a refused retry alone is not that proof.
    if (error instanceof DraftConflict || error instanceof WriteAuthorityError) {
      if (!candidateMayHaveCommitted) await removeDraftSnapshot(docRef.id, { storagePrefix });
      else await removeUnreferencedCandidate(args.db, docRef, storagePrefix);
    }
    throw error;
  }
  if (transactionCandidateStaged) await clearReceipt(docRef, linkSave);
  if (reused) {
    if (!candidateMayHaveCommitted) await removeDraftSnapshot(docRef.id, { storagePrefix });
    else await removeUnreferencedCandidate(args.db, docRef, storagePrefix);
    return { ...draft, draftRevision: draftRevision({ currentVersion: baseVersion, draft }), liveEpoch: savedEpoch };
  }
  await removeDraftSnapshot(docRef.id, previous);
  if (retiredEpoch !== undefined) await retireLiveSession(args.db, docRef.id, retiredEpoch);
  return { ...draft, draftRevision: draftRevision({ currentVersion: baseVersion, draft }), liveEpoch: savedEpoch };
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
  data: { currentVersion?: unknown; draft?: { baseVersion?: unknown; storagePrefix?: unknown } | null },
): Promise<WorkingCopy | null> {
  const baseVersion = String(data.currentVersion ?? "");
  const version = baseVersion ? await loadVersionMeta(docRef, baseVersion) : null;
  if (!version) return null;
  // A draft of an older version is not the working copy of this one.
  const hasDraft = data.draft?.baseVersion === baseVersion;
  const read = (rel: string) =>
    readFirst([
      ...(hasDraft ? [`${versionStoragePrefix(docRef.id, "draft", data.draft ?? {})}/${rel}`] : []),
      ...(!hasDraft ? [`${version.storagePrefix}/${rel}`] : []),
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

export type CommitOutcome = { status: 200 | 403 | 409; body: Record<string, unknown> };

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
  draft: { entry?: unknown; editSessions?: unknown; storagePrefix?: unknown; updatedAt?: unknown; baseVersion?: unknown } | null | undefined;
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
  const draftPrefix = `${versionStoragePrefix(docId, "draft", draft)}/`;
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

  let retiredEpoch = "initial";
  const dup = await versionsRef.doc(baseVersion).get();
  if (dup.exists && dup.data()?.contentHash === contentHash) {
    const retirementEpoch = randomUUID();
    const retirement = freshReceiptId();
    try {
      await db.runTransaction(async (tx) => {
        const snapshot = await tx.get(docRef);
        const own = readReceipt<string>(snapshot, retirement);
        if (own.found) { retiredEpoch = own.result; return; }
        const current = snapshot.data();
        checkDraftBase(current, baseVersion);
        await assertWriteAuthority(tx, docRef, current as DocAclData, { uid: actor.uid ?? "", emailLower: args.emailLower });
        checkDraftSnapshot(current, draft);
        if (await anyOpenThread(tx, docRef, baseVersion, "threads")) throw new Error("OPEN");
        retiredEpoch = String(current?.liveEpoch ?? "initial");
        tx.update(docRef, { draft: FieldValue.delete(), liveEpoch: retirementEpoch, updatedAt: now() });
        // Later publications replace liveEpoch. Keep this invocation's own
        // result until the SDK confirms it, independent of the current head.
        recordReceipt(tx, docRef, snapshot, retirement, retiredEpoch);
      });
    } catch (error) {
      if (error instanceof WriteAuthorityError) return { status: error.status, body: error.detail };
      if (error instanceof DraftConflict) return { status: 409, body: error.detail };
      if ((error as Error).message === "OPEN") {
        return { status: 409, body: await openThreadsRefusal(docRef, baseVersion) ?? { error: "The review changed. Retry publishing." } };
      }
      throw error;
    }
    await clearReceipt(docRef, retirement);
    await removeDraftSnapshot(docId, draft);
    await retireLiveSession(db, docId, retiredEpoch);
    return {
      status: 200,
      body: { versionId: dup.id, contentHash, fileCount, bytes, deduped: true },
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
  let candidateMayHaveCommitted = false;

  try {
    await db.runTransaction(async (tx) => {
      const cur = await tx.get(docRef);
      const vRef = versionsRef.doc(versionId);
      const candidate = await tx.get(vRef);
      // A unique immutable prefix proves this request already published, even
      // if another writer has advanced the head since its acknowledgement was lost.
      if (candidateMayHaveCommitted && candidate.data()?.storagePrefix === storagePrefix) return;
      if ((cur.data()?.currentVersion as string) !== baseVersion) throw new Error("STALE");
      await assertWriteAuthority(tx, docRef, cur.data() as DocAclData, { uid: actor.uid ?? "", emailLower: args.emailLower });
      checkDraftSnapshot(cur.data(), draft);
      retiredEpoch = String(cur.data()?.liveEpoch ?? "initial");
      if (await anyOpenThread(tx, docRef, baseVersion, "threads")) throw new Error("OPEN");
      if (candidate.exists) throw new Error("CONFLICT");
      // Trust never carries into a new version, the owner's included (SPEC §6c).
      // A draft is shared: an editor, or any account on a public document open
      // to editing, can put a script in it through /draft or the live merge,
      // and the owner who commits it never sees one in the sandboxed editor.
      // Carrying trust when the OWNER committed ran that script in every
      // trusting reader's session. A reader trusted the scripts they saw.
      const grants = await readTrustGrants(tx, docRef);
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
        origin: "edit",
        publishedVia: publishedViaOf("edit", actor),
        publishedByEmail: args.emailLower,
        publishedBy: actor,
        editSessions,
        publishedAt: now(),
      });
      tx.set(
        docRef,
        {
          currentVersion: versionId,
          liveEpoch: randomUUID(),
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
      withdrawTrust(tx, docRef, grants);
      candidateMayHaveCommitted = true;
    });
  } catch (e) {
    // These refusals precede this callback's writes, but an earlier callback
    // may already have committed. Prove staged candidates are unreferenced.
    if (e instanceof DraftConflict || e instanceof WriteAuthorityError || ["STALE", "CONFLICT", "OPEN"].includes((e as Error).message)) {
      if (candidateMayHaveCommitted) await removeUnreferencedCandidate(db, docRef, storagePrefix);
      else await removeDraftSnapshot(docId, { storagePrefix });
    }
    if (e instanceof WriteAuthorityError) return { status: e.status, body: e.detail };
    if (e instanceof DraftConflict) return { status: 409, body: e.detail };
    const reason = (e as Error).message;
    if (reason === "OPEN") {
      // Opened while the bytes were uploading: refused as it would have been before.
      const open = await openThreadsRefusal(docRef, baseVersion);
      if (open) return { status: 409, body: open };
    }
    if (reason === "STALE" || reason === "CONFLICT" || reason === "OPEN" || reason === "DRAFT_CHANGED") {
      const fresh = await docRef.get();
      return {
        status: 409,
        body: {
          error: "The document or draft changed. Read it again before publishing.",
          currentVersion: fresh.data()?.currentVersion,
        },
      };
    }
    throw e;
  }

  await removeDraftSnapshot(docId, draft);
  await retireLiveSession(db, docId, retiredEpoch);

  return { status: 200, body: { versionId, contentHash, fileCount, bytes, deduped: false } };

}
