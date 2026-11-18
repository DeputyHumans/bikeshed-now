// SPDX-License-Identifier: Apache-2.0
// What every MCP tool shares: limits, the tool types, and the reads several tools make alike (SPEC §19).

import {
  freshReceiptId,
  readReceipt,
  recordReceipt,
  clearReceipt,
} from "../../lib/transaction-receipts";
import { versionObjectKey } from "../../lib/storage";
import * as admin from "firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { mutationVersion } from "../../lib/versions";
import { bucketName, publicOrigin } from "../../config";
import { actedThrough, type Actor } from "../../lib/actor";
import type { Principal } from "../../lib/auth";
import {
  canManageSharing,
  canRead,
  canSuggest,
  frozenWrite,
  isFrozen,
  isFolderBasis,
  type DocAclData,
} from "../../lib/acl";
import { loadReadAccess } from "../../lib/reach";
import { documentAudience, filedIn } from "../../lib/audience";
import { encodeCursor, headCursor, saveCursor, type EventActor } from "../../lib/events";
import { linkProofFor } from "../../lib/linkgrant";
import { type Lineage } from "../../lib/fork";
import { locateQuote } from "../../lib/quote";
import { setThreadResolved } from "../../lib/threads";
import { changeSuggestion, type DecisionOp } from "../../lib/suggestions";
import { safeSegment } from "../../lib/http";

type Db = admin.firestore.Firestore;

export const LIST_LIMIT = 50;
export const COMMENT_LIMIT = 50;
/** Events per get_changes page. */
export const CHANGE_PAGE = 100;
/** How often get_changes suggests asking, in seconds. */
export const RETRY_AFTER_SECONDS = 60;

/**
 * The folder tree comes back whole or not at all.
 *
 * Paginating it would be worse than capping it: a page of folders cannot render
 * its own paths, because an ancestor may be on the next page, so half a tree is
 * a tree with wrong names in it. A workspace with more than two hundred folders
 * says so in `truncated` rather than quietly returning some of them.
 */
export const FOLDER_LIMIT = 200;
/**
 * One page of a document's content, so one oversized document cannot consume
 * an agent's context. The rest comes by `offset`, page after page from one
 * version, and the CLI walks the pages itself to print the whole.
 */
export const SOURCE_LIMIT = 200_000;

/** Markup an HTML document's content has to contain: a tag or a doctype. A Markdown reading has neither. */
export const LOOKS_LIKE_HTML = /<(?:!doctype|[a-z][a-z0-9-]*)[\s/>]/i;

/** Where one page starting at `offset` ends, never splitting a surrogate pair. */
export function pageEnd(text: string, offset: number, limit = SOURCE_LIMIT): number {
  let end = Math.min(text.length, offset + limit);
  if (end < text.length && end > offset + 1) {
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  }
  return end;
}

/** `offset` as given, or a refusal an agent can act on. */
export function offsetOf(args: Record<string, unknown>): number {
  const raw = args.offset;
  if (raw === undefined || raw === null) return 0;
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
    throw new Error("offset must be a whole number of characters, 0 or more: the nextOffset a previous call returned");
  }
  return n;
}

export interface ToolContext {
  db: Db;
  caller: Principal;
  actor: Actor;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (ctx: ToolContext, args: Record<string, unknown>) => Promise<unknown>;
}

export function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v.trim() : "";
}

export function asArray(v: unknown): string[] {
  return Array.isArray(v) ? (v as string[]) : [];
}

/** One earlier form of a suggestion, as an agent reads it. */
export function revisionOut(r: { replacement?: unknown; note?: unknown; at?: { toDate?: () => Date }; actor?: Actor }) {
  return {
    replacement: String(r.replacement ?? ""),
    ...(typeof r.note === "string" && r.note ? { note: r.note } : {}),
    at: r.at?.toDate?.().toISOString() ?? null,
    ...actedThrough(r.actor),
  };
}

/**
 * A folder's full path, given the names the caller is allowed to know.
 *
 * An ancestor can be INVISIBLE. Membership cascades downward, so a grant on a
 * folder carries to everything beneath it — but a grant made directly on a
 * child says nothing about its parent, and that parent is then absent from the
 * caller's listing. Rendering its raw id would look like a folder they could
 * navigate to; dropping the level entirely would make a nested folder read as a
 * top-level one, and an agent would file things by a path that does not exist.
 *
 * An ellipsis is the only one of the three that is true: there is a level here,
 * and it is not yours.
 *
 * Pure, and exported, because it is the only part of `list_folders` with a
 * decision in it — the rest is a query.
 */
export function folderPath(
  ancestors: readonly string[],
  name: string,
  nameOf: ReadonlyMap<string, string>,
): string {
  return [...ancestors.map((id) => nameOf.get(id) ?? "…"), name].join("/");
}

/**
 * Where a document is filed and who can read it there, read from the record
 * after a write, so what the agent tells a person is what the server did
 * rather than what the agent read a minute earlier.
 */
export async function whereAndWho(ctx: ToolContext, docId: string) {
  const snap = await ctx.db.collection("docs").doc(docId).get();
  const data = (snap.data() ?? {}) as DocAclData & Record<string, unknown>;
  const folderId = typeof data.folderId === "string" ? data.folderId : null;
  const [paths, access] = await Promise.all([
    filedIn(ctx.db, ctx.caller, [folderId]),
    documentAudience(ctx.db, ctx.caller, data),
  ]);
  return { filedIn: (folderId && paths.get(folderId)) || null, access };
}

/**
 * A person, in the app, spoke last in this open thread. Notes the server wrote
 * ("Accepted.", "Resolved.") are not anybody speaking; an agent's comment is
 * never somebody waiting, so two agents watching one document cannot keep
 * answering each other.
 */
export function awaitsReply(
  ann: Record<string, unknown>,
  comments: ReadonlyArray<{ data: () => Record<string, unknown> | undefined }>,
): boolean {
  if (ann.resolved === true) return false;
  const latest = [...comments]
    .map((c) => c.data() ?? {})
    .filter((c) => !(c.opensSuggestion === true && c.generated === true))
    .reverse()
    .find((c) => c.generated !== true);
  return latest !== undefined && ((latest.actor as Actor | undefined)?.channel ?? "web") === "web";
}

/**
 * The cursor a reader starts watching from: the newest event already in the
 * log, so everything recorded after this moment is news to them.
 *
 * Saved as the credential's "last" only by a call that has seen everything
 * before it: a new document (`always`), or one this credential has no cursor
 * for yet (`ifNone`). A write to an existing document never moves a cursor,
 * because the log may hold events after the caller's last poll that it has
 * not seen, and a cursor at the head would skip them (SPEC §19).
 */
export async function startingCursor(
  ctx: ToolContext,
  docRef: admin.firestore.DocumentReference,
  save: "always" | "ifNone",
): Promise<string> {
  const cursor = encodeCursor(await headCursor(docRef));
  if (ctx.caller.tokenId) {
    await saveCursor(ctx.db, ctx.caller.uid, ctx.caller.tokenId, docRef.id, cursor, { onlyIfNone: save === "ifNone" });
  }
  return cursor;
}

/** An event this credential caused: an agent channel AND this token, so a browser cannot forge one. */
export function causedBy(actor: EventActor | undefined, caller: Principal): boolean {
  return !!actor && actor.channel !== "web" && !!caller.tokenId && actor.tokenId === caller.tokenId;
}

/** Firestore refusing a query for want of a composite index (FAILED_PRECONDITION). */
export function isMissingIndex(e: unknown): boolean {
  const err = e as { code?: unknown; message?: unknown };
  return err?.code === 9 || /FAILED_PRECONDITION|requires an index/i.test(String(err?.message ?? ""));
}

/** How every tool that reads one document describes the unlisted key. */
export const LINK_KEY_DESCRIPTION =
  "Only for an unlisted document you are not a member of: the key from its link, the value after ?k=. Without it such a document answers exactly as an id that does not exist.";

/**
 * How the tools that only READ describe it: a folder's key opens what is
 * beneath the folder to read, and nothing else (SPEC §17 "A folder's reach").
 */
export const READ_KEY_DESCRIPTION =
  "Only for a document you are not a member of: the key from its link, the value after ?k=, whether the document's own or a shared folder's above it. A folder's key reads and nothing else. Without a key such a document answers exactly as an id that does not exist.";

/**
 * Load a document the caller may read, or fail exactly as for an id that does
 * not exist. `k` is an unlisted document's key; a caller whose account already
 * holds a link grant needs none (SPEC §17).
 */
export async function loadDoc(ctx: ToolContext, slug: string, k: string | null = null) {
  const ref = ctx.db.collection("docs").doc(slug);
  const snap = await ref.get();
  if (!snap.exists) throw new Error(`no document with id "${slug}"`);
  const data = snap.data() as DocAclData & Record<string, unknown>;
  const proof = await linkProofFor(ref, data, ctx.caller, k);
  if (!canRead(data, ctx.caller, proof)) {
    // A folder's key reads, and this is a tool that does more. Saying so tells
    // nobody anything new: the key already lets them read the document.
    if (k && !isFrozen(data, Date.now()) && (await loadReadAccess(ctx.db, data, ctx.caller, proof)) !== null) {
      throw new Error("this document is shared with you through a folder's link, which lets you read it and nothing else");
    }
    throw new Error(`no document with id "${slug}"`);
  }
  // An expired or trashed document reads as absent to everyone but its owner —
  // the same answer a document they may not read gives, so neither can be used
  // to confirm that a slug exists (SPEC §4, §17).
  if (isFrozen(data, Date.now()) && !canManageSharing(data, ctx.caller.emailLower)) {
    throw new Error(`no document with id "${slug}"`);
  }
  return { ref, snap, data, proof };
}

/**
 * `loadDoc` for a tool that only READS: a shared folder's key above the
 * document opens it too (SPEC §17 "A folder's reach"). `viaFolder` says that is
 * how, so the tool can say the reader may do nothing else.
 */
export async function loadDocForRead(ctx: ToolContext, slug: string, k: string | null = null) {
  const ref = ctx.db.collection("docs").doc(slug);
  const snap = await ref.get();
  if (!snap.exists) throw new Error(`no document with id "${slug}"`);
  const data = snap.data() as DocAclData & Record<string, unknown>;
  const proof = await linkProofFor(ref, data, ctx.caller, k);
  const access = await loadReadAccess(ctx.db, data, ctx.caller, proof);
  if (access === null) throw new Error(`no document with id "${slug}"`);
  if (isFrozen(data, Date.now()) && !canManageSharing(data, ctx.caller.emailLower)) {
    throw new Error(`no document with id "${slug}"`);
  }
  return { ref, snap, data, proof, viaFolder: isFolderBasis(access.basis), basis: access.basis };
}

/**
 * Find an agent's quoted passage in a document's current version.
 *
 * Looked for in the RENDERED entry, which is what a reader reads and what the
 * browser will look in: for a Markdown document, its HTML, not its source.
 * `crossesBlock` is the one refusal that differs by tool, because what to do
 * about a passage spanning two paragraphs depends on what is being done to it.
 */
export async function locateInCurrentVersion(
  ref: admin.firestore.DocumentReference,
  versionId: string,
  args: Record<string, unknown>,
  crossesBlock: string,
) {
  const vSnap = await ref.collection("versions").doc(versionId).get();
  const entry = String(vSnap.data()?.entry ?? "index.html");
  let html = "";
  try {
    const key = versionObjectKey(ref.id, versionId, vSnap.data() ?? {}, entry);
    if (!key) throw new Error("the version lists no entry");
    const [bytes] = await admin.storage().bucket(bucketName()).file(key).download();
    html = bytes.toString("utf8");
  } catch {
    throw new Error("could not read the current version");
  }

  const located = locateQuote(html, {
    exact: String(args.exact ?? ""),
    prefix: typeof args.prefix === "string" ? args.prefix : undefined,
    suffix: typeof args.suffix === "string" ? args.suffix : undefined,
  });
  if ("error" in located) {
    throw new Error(
      located.error === "ambiguous"
        ? `that passage occurs ${located.count} times; add a prefix or suffix of the words around the one you mean`
        : located.error === "crosses-block"
          ? crossesBlock
          : "that passage is not in the current version; quote it as a reader sees it, without Markdown or HTML, within one paragraph",
    );
  }
  return { versionId, anchor: located.anchor };
}

/**
 * Revise or withdraw one of the caller's own pending suggestions on the
 * current version, where every pending one is: it holds back the next version
 * until it is closed. Whose it is, and whether it is still open, is decided
 * by `changeSuggestion`, as for the app (SPEC §22).
 */
export async function changeOwnSuggestion(
  ctx: ToolContext,
  args: Record<string, unknown>,
  op: Extract<DecisionOp, "revise" | "withdraw">,
  change: { replacement?: string; note?: string },
) {
  const { ref, data, proof } = await loadDoc(ctx, str(args, "id"), str(args, "k"));
  refuseIfFrozen(data);
  const threadId = str(args, "threadId");
  if (!threadId || !safeSegment(threadId)) throw new Error("threadId is required: the suggestion's thread");
  const versionId = mutationVersion(args.version, data);
  const changed = await changeSuggestion({
    db: ctx.db,
    docRef: ref,
    versionId,
    annId: threadId,
    op,
    caller: { uid: ctx.caller.uid, emailLower: ctx.caller.emailLower },
    actor: ctx.actor,
    maySuggest: canSuggest(data, ctx.caller, proof),
    ...change,
  });
  if ("status" in changed) throw new Error(changed.error);
  return withReaderAddress({ threadId, version: versionId, state: changed.state }, ref.id);
}

/**
 * Resolve or reopen a thread on the current version, as any reader may in the
 * app. Threads on an earlier version are left as they were: what stands there
 * is the record of that version's review (SPEC §6, §19).
 */
export async function changeThread(ctx: ToolContext, args: Record<string, unknown>, resolved: boolean) {
  const { ref, data } = await loadDoc(ctx, str(args, "id"), str(args, "k"));
  refuseIfFrozen(data);
  const threadId = str(args, "threadId");
  if (!threadId || !safeSegment(threadId)) throw new Error("threadId is required: the thread, from get_comments");
  const versionId = mutationVersion(args.version, data);
  const changed = await setThreadResolved({
    db: ctx.db,
    docRef: ref,
    versionId,
    annId: threadId,
    resolved,
    caller: { uid: ctx.caller.uid, emailLower: ctx.caller.emailLower },
    actor: ctx.actor,
  });
  if ("status" in changed) throw new Error(changed.error);
  return withReaderAddress({ threadId, version: versionId, resolved: changed.resolved }, ref.id);
}

/** Writes are refused on an expired or trashed document, the owner's included. */
export function refuseIfFrozen(data: DocAclData): void {
  const frozen = frozenWrite(data, Date.now());
  if (frozen) throw new Error(frozen.error);
}

/**
 * Record the fetch as an automated read.
 *
 * `ms: 0` into `stats.apiReads`, never into `stats.views` or `stats.totalMs`.
 * An agent calling this forty times would otherwise turn a document's reading
 * statistics into noise, and reading TIME is not a concept that applies to a
 * machine fetch at all (SPEC §17).
 */
export async function recordApiRead(
  ctx: ToolContext,
  docRef: admin.firestore.DocumentReference,
  versionId: string,
): Promise<void> {
  const sessionId = `api-${ctx.actor.tokenId ?? ctx.caller.uid}-${versionId}`;
  const viewRef = docRef.collection("views").doc(sessionId);
  const receipt = freshReceiptId();
  try {
    await ctx.db.runTransaction(async (tx) => {
      const before = await tx.get(viewRef);
      if (readReceipt(before, receipt).found) return;
      recordReceipt(tx, viewRef, before, receipt, true);
      const startedAt = before.data()?.startedAt;
      tx.set(viewRef, {
        sessionId, uid: ctx.caller.uid, email: ctx.caller.emailLower, versionId,
        ms: 0, via: "app", automated: true, actor: ctx.actor,
        reads: FieldValue.increment(1),
        startedAt: startedAt instanceof Timestamp ? startedAt : FieldValue.serverTimestamp(),
        lastBeatAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      tx.update(docRef, {
        "stats.apiReads": FieldValue.increment(1),
        "stats.lastViewedByEmail": FieldValue.delete(),
      });
    });
    await clearReceipt(viewRef, receipt);
  } catch {
    /* statistics are best-effort and never fail the read */
  }
}

/**
 * A result, plus where a reader opens the document.
 *
 * An agent over MCP cannot work this out. The origin lives in its client's
 * configuration, not in anything the protocol hands it, so the one thing it has
 * to give a person back — the address — is the one thing only the server knows.
 *
 * Omitted rather than guessed when the deployment has no configured origin: a
 * bare `/d/<id>` path looks like an address and is not one, and an agent that
 * pastes it has handed over something broken (SPEC §17).
 */
export function withReaderAddress<T extends object>(result: T, docId: string, version?: string, k?: string): T {
  const origin = publicOrigin();
  return origin ? { ...result, url: `${origin}/d/${docId}${version ? `/${encodeURIComponent(version)}` : ""}${k ? `?k=${encodeURIComponent(k)}` : ""}` } : result;
}

/**
 * The lineage answer, in the vocabulary the other tools use: `id` and
 * `version`, an ISO date, and the address a person opens for every document an
 * agent might hand back. Nothing is added that the endpoint did not decide the
 * caller may see; this only renames and dates it. Pure, so the shape is pinned.
 */
export function lineageForAgent(docId: string, lineage: Lineage) {
  return {
    id: docId,
    forked: lineage.forked,
    // Nearest first. Stops at the first document the caller cannot open.
    forkedFrom: lineage.ancestors.map((a) =>
      withReaderAddress(
        {
          id: a.docId,
          title: a.title,
          version: a.versionId,
          ...(a.ownerEmail ? { owner: a.ownerEmail } : {}),
          ...(a.changed !== undefined ? { changedSince: a.changed } : {}),
        },
        a.docId,
      ),
    ),
    moreYouCannotOpen: lineage.hiddenAncestor,
    moreWasDeleted: lineage.deletedAncestor,
    ...(lineage.forks
      ? {
          forks: {
            total: lineage.forks.total,
            youCannotOpen: lineage.forks.hidden,
            listed: lineage.forks.visible.map((f) =>
              withReaderAddress(
                {
                  id: f.docId,
                  title: f.title,
                  visibility: f.visibility,
                  forkedAt: f.forkedAt === null ? null : new Date(f.forkedAt).toISOString(),
                  ...(f.ownerEmail ? { owner: f.ownerEmail } : {}),
                },
                f.docId,
              ),
            ),
          },
        }
      : {}),
  };
}
