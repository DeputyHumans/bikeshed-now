// SPDX-License-Identifier: Apache-2.0
// The workspace: suggestions, upload, folders, organizing and forking (SPEC §2, §13, §21, §22).

import { onRequest, type Request } from "firebase-functions/v2/https";
import { MAX_BUNDLE_BYTES, UPLOAD_CHUNK_BYTES, publicOrigin } from "../config";
import { checkSessionRequest, openSession, readStaged, type StagedFile, type StagingBucket } from "../lib/staging";
import { blobKey } from "../lib/storage";
import { PublishRefusal } from "../lib/publish";
import type { ListedFile } from "../lib/hash";
import { getAccess, setAccess as changeAccess, organizeFolder } from "../lib/management";
import { restoreDocument, restoreFolder, trashDocument, trashFolder } from "../lib/trash";
import {
  canEdit,
  canManageSharing,
  canRead,
  canSuggest,
  frozenWrite,
  isDocApprover,
  isDocEditor,
  type DocAclData,
} from "../lib/acl";
import { actorFrom, resolveCaller } from "../lib/actor";
import { compileBundle, publishNewDocument, reviseDocument } from "../lib/publish";
import {
  SUGGESTION_COLOR,
  changeSuggestion,
  createSuggestion,
  isDecisionOp,
  parseAnchor,
  parseNote,
} from "../lib/suggestions";
import { extractBundle, extractLoose, safeBundleRelPath, type BundleEntry, type ExtractedBundle } from "../lib/bundle";
import type { Principal } from "../lib/auth";
import {
  createFolderRecord,
  BAD_DOC_ID,
  isValidDocId,
  persistDocMembership,
  resolveFolderTarget,
} from "../lib/folders";
import { forkDocument, lineageFor } from "../lib/fork";
import { linkProofFor } from "../lib/linkgrant";
import { renameDocument } from "../lib/rename";
import { documentAudience, filedIn } from "../lib/audience";
import { encodeCursor, eventActor, headCursor, saveCursor } from "../lib/events";
import {
  badRequest,
  jsonBody,
  noStore,
  rawBuffer,
  rejectMethod,
  safeSegment,
  strParam,
} from "../lib/http";
import { db, bucket, refusal, MAILING, MINTING, PLAIN } from "./runtime";
import { managementFailure, MOVE_IS_SHARING } from "./sharing";

// ---------------------------------------------------------------------------
// Workspace: upload, folders, organize, fork
// ---------------------------------------------------------------------------


/**
 * POST /suggestion — every change to a suggested edit (SPEC §22).
 *
 * `{ op, docId, versionId, k?, … }`, where `op` is
 *
 *   create    `anchor, replacement, note?`  anyone who may suggest, any channel
 *   revise    `annId, replacement, note?`   its author, any channel
 *   withdraw  `annId`                       its author, any channel
 *   claim     `annId, replacement?`         an approver, in the app
 *   release   `annId`                       an approver, their own claim, in the app
 *   accept    `annId, replacement?`         an approver, in the app, after applying it
 *   reject    `annId, reason?`              an approver, in the app
 *
 * A claim or an accept that names the replacement being applied is refused
 * when its author has changed it since: what goes into the draft and what is
 * recorded as accepted are then the same text.
 *
 * The only path that writes the `suggestion` field; the rules refuse every
 * client write that names it. Here, claim, release, accept and reject come
 * from the app alone: an accept on this endpoint records what the approver's
 * browser has already applied, which a token cannot have done. An agent
 * decides through its own tools, which check the same role (ADR 0015).
 * Revise and withdraw change only the caller's own pending proposal and
 * destroy nothing (the earlier text is kept, and a withdrawn thread stays), so
 * a token may do either.
 *
 * `accept` does not apply anything. The approver's browser has already made
 * the change in their editing session and saved the draft; this records the
 * decision, and refuses when there is no draft of this version for the change
 * to be in (ADR 0013).
 */
export const manageSuggestion = onRequest(PLAIN, async (req, res) => {
  noStore(res); // before any branch can return — see noStore()
  if (rejectMethod(req, res, ["POST"])) return;
  const caller = await resolveCaller(req);
  if (!caller) {
    res.status(401).end();
    return;
  }

  const body = (jsonBody(req) ?? {}) as Record<string, unknown>;
  const op = body.op;
  if (op !== "create" && !isDecisionOp(op)) {
    badRequest(res, "op must be create, revise, withdraw, claim, release, accept or reject");
    return;
  }
  const docId = typeof body.docId === "string" ? body.docId : "";
  const versionId = typeof body.versionId === "string" ? body.versionId : "";
  if (!docId || !safeSegment(docId) || !versionId || !safeSegment(versionId)) {
    badRequest(res, "invalid or missing docId or versionId");
    return;
  }

  const ref = db().collection("docs").doc(docId);
  const snap = await ref.get();
  if (!snap.exists) {
    res.status(404).end();
    return;
  }
  const data = snap.data() as DocAclData & {
    currentVersion?: string;
    draft?: { baseVersion?: unknown } | null;
  };
  const proof = await linkProofFor(ref, data, caller, typeof body.k === "string" ? body.k : null);
  if (!canRead(data, caller, proof)) {
    res.status(refusal(data, caller, proof)).end();
    return;
  }
  // Frozen for everyone, the owner included, as every other write is.
  const frozen = frozenWrite(data, Date.now());
  if (frozen) {
    res.status(409).json(frozen);
    return;
  }
  const actor = actorFrom(caller, req);
  const author = { uid: caller.uid, emailLower: caller.emailLower };

  if (op === "create") {
    if (!canSuggest(data, caller, proof)) {
      res.status(403).json({ error: "You can read this document, but not suggest edits to it." });
      return;
    }
    if (data.currentVersion !== versionId) {
      res.status(409).json({
        error: "This document has a newer version. Reload, then suggest the edit on it.",
        currentVersion: data.currentVersion,
      });
      return;
    }
    const anchor = parseAnchor(body.anchor);
    if ("error" in anchor) {
      badRequest(res, anchor.error);
      return;
    }
    if (typeof body.replacement !== "string") {
      badRequest(res, "replacement must be a string; send an empty one to suggest a deletion");
      return;
    }
    const note = parseNote(body.note);
    if (typeof note !== "string") {
      badRequest(res, note.error);
      return;
    }
    const created = await createSuggestion({
      db: db(),
      docRef: ref,
      versionId,
      anchor,
      replacement: body.replacement,
      note,
      author,
      actor,
      color: SUGGESTION_COLOR,
    });
    if ("status" in created) {
      const { status, ...rest } = created;
      res.status(status).json(rest);
      return;
    }
    res.status(200).json({ annId: created.annId, versionId });
    return;
  }

  // Everything else changes a suggestion that exists.
  const annId = typeof body.annId === "string" ? body.annId : "";
  if (!annId || !safeSegment(annId)) {
    badRequest(res, "invalid or missing annId");
    return;
  }
  const deciding = op === "claim" || op === "release" || op === "accept" || op === "reject";
  if (deciding && actor.channel !== "web") {
    res.status(403).json({
      error:
        "Through this endpoint a suggestion is decided in the app. An agent decides one with accept_suggestion or reject_suggestion.",
    });
    return;
  }
  if (deciding && !isDocApprover(data, caller.uid, caller.emailLower)) {
    res.status(403).json({ error: "Only the owner or an approver can accept or reject a suggestion." });
    return;
  }
  if (data.currentVersion !== versionId) {
    res.status(409).json({
      error: "This document has a newer version, so this suggestion can no longer be applied.",
      currentVersion: data.currentVersion,
    });
    return;
  }
  if (op === "accept" && data.draft?.baseVersion !== versionId) {
    res.status(409).json({
      error: "Apply the suggestion in the editor first: there is no draft of this version for it to be in.",
    });
    return;
  }
  const note = parseNote(body.note);
  if (typeof note !== "string") {
    badRequest(res, note.error);
    return;
  }
  if ((op === "revise" || op === "claim" || op === "accept") && body.replacement !== undefined && typeof body.replacement !== "string") {
    badRequest(res, "replacement must be a string");
    return;
  }
  if (op === "revise" && typeof body.replacement !== "string") {
    badRequest(res, "replacement must be a string; send an empty one to suggest a deletion");
    return;
  }

  const changed = await changeSuggestion({
    db: db(),
    docRef: ref,
    versionId,
    annId,
    op,
    caller: author,
    actor,
    maySuggest: canSuggest(data, caller, proof),
    replacement: typeof body.replacement === "string" ? body.replacement : undefined,
    note,
    reason: typeof body.reason === "string" ? body.reason : undefined,
  });
  if ("status" in changed) {
    const { status, ...rest } = changed;
    res.status(status).json(rest);
    return;
  }
  res.status(200).json(changed);
});

/**
 * POST /publish (createDoc) — a NEW document from a browser upload.
 *
 * The raw request body is the file; metadata rides in the query string. Created
 * `trusted: false`: the uploader is not necessarily the author, so the viewer
 * sandboxes its scripts until somebody with standing says otherwise (SPEC §6c).
 *
 * With `?update=<docId>` it publishes a new version of that document instead.
 * See `updateFromUpload`.
 */
export const createDoc = onRequest(MINTING, async (req, res) => {
  if (rejectMethod(req, res, ["POST"])) return;
  // Every answer here is the caller's own, and a session URL is a secret.
  noStore(res);
  const caller = await resolveCaller(req);
  if (!caller) {
    res.status(401).end();
    return;
  }
  if (req.path === "/media") {
    await openMediaSession(req, res, caller);
    return;
  }

  const updating = strParam(req, "update");
  const merging = strParam(req, "merge") === "1";
  // Large media sent through sessions, and files the document already stores
  // that the client chose not to send again (SPEC §2, §24).
  const stagingIds = listParam(req, "media");
  const haves = listParam(req, "have");
  if (stagingIds.length > MAX_STAGED || haves.length > 2000) {
    badRequest(res, `a publish names at most ${MAX_STAGED} staged uploads`);
    return;
  }
  if (haves.length > 0 && !updating) {
    badRequest(res, "have names files a document already stores, so it needs update=<id>");
    return;
  }
  const staged = stagingIds.length === 0 ? { files: [] as StagedFile[] } : await readStaged({
    bucket: bucket() as unknown as StagingBucket,
    uid: caller.uid,
    docId: updating || null,
    stagingIds,
  });
  if ("error" in staged) {
    res.status(409).json(staged);
    return;
  }
  const kept = await readHaves(updating, haves);
  if ("error" in kept) {
    badRequest(res, kept.error);
    return;
  }
  const extra: ListedFile[] = [...staged.files.map((f) => ({ rel: f.rel, size: f.size, sha256: f.sha256 })), ...kept.files];
  const stagedInput = staged.files.length > 0 ? { staged: { bucket: bucket() as unknown as StagingBucket, files: staged.files } } : {};

  const buffer = rawBuffer(req);
  const empty = !buffer || buffer.length === 0;
  // Laying staged media over a version needs no body; anything else does.
  if (empty && !(merging && updating && extra.length > 0)) {
    badRequest(res, "no file uploaded");
    return;
  }
  const wantedId = strParam(req, "id");
  if (wantedId && !isValidDocId(wantedId)) {
    badRequest(res, BAD_DOC_ID);
    return;
  }
  const filename = strParam(req, "filename");

  // Loose files laid over the current version, each replacing the file of the
  // same name or added, everything else kept (SPEC §2): what dropping a new
  // screenshot on a document means. The body is a .zip of them.
  if (merging) {
    if (!updating) {
      badRequest(res, "merge lays files over a document's current version, so it needs update=<id>");
      return;
    }
    const loose = empty ? { files: [] as BundleEntry[] } : extractLoose(buffer as Buffer, MAX_BUNDLE_BYTES);
    if ("error" in loose) {
      badRequest(res, loose.error);
      return;
    }
    await updateFromUpload(req, res, caller, updating, { overlay: { files: [...loose.files, ...extra], byName: true }, ...stagedInput });
    return;
  }

  const extracted = extractBundle(buffer as Buffer, filename, MAX_BUNDLE_BYTES);
  if ("error" in extracted) {
    badRequest(res, extracted.error);
    return;
  }

  if (updating) {
    await updateFromUpload(req, res, caller, updating, { extracted, extra, ...stagedInput });
    return;
  }

  const target = await resolveFolderTarget(db(), strParam(req, "folderId"), caller);
  if (!target.ok) {
    res.status(target.status).json({ error: target.error });
    return;
  }

  const fileBase = filename.replace(/\.[^./\\]+$/, "");
  const compiled = compileBundle(
    extracted,
    strParam(req, "title") || fileBase || "Untitled document",
  );

  const result = await publishNewDocument({
    db: db(),
    actor: actorFrom(caller, req),
    ownerEmail: caller.emailLower,
    ownerUid: caller.uid,
    compiled,
    ...stagedInput,
    title: strParam(req, "title") || compiled.title,
    folderId: target.id,
    parentMembership: target.membership,
    marking: strParam(req, "marking") ? jsonParam(req, "marking") : undefined,
    ...(wantedId ? { docId: wantedId } : {}),
  }).catch((e: Error) => e);

  if (result instanceof PublishRefusal) {
    badRequest(res, result.message);
    return;
  }
  if (result instanceof Error) {
    res.status(500).json({ error: "could not create the document" });
    return;
  }
  // Where it landed and who can read it there, as publish_document says it, so
  // `bikeshed publish --json` can tell a person the same thing. The document
  // exists by now: a failed read here costs the description, never the publish.
  const told = await (async () => {
    try {
      const docRef = db().collection("docs").doc(result.docId);
      const data = (await docRef.get()).data() ?? {};
      const [paths, access, head] = await Promise.all([
        filedIn(db(), caller, [target.id]),
        documentAudience(db(), caller, data),
        headCursor(docRef),
      ]);
      // Where `bikeshed changes` starts watching: nothing after this is missed.
      const cursor = encodeCursor(head);
      if (caller.tokenId) await saveCursor(db(), caller.uid, caller.tokenId, result.docId, cursor);
      return { filedIn: (target.id && paths.get(target.id)) || null, access, cursor };
    } catch {
      return {};
    }
  })();
  res.status(200).json({ ...result, ...told });
});

/**
 * POST /publish?update=<docId> — a new version of an existing document, from
 * raw bytes.
 *
 * It rides this endpoint because this is the only one that takes bytes, and a
 * `.zip` cannot reach the tools: they take text, and an archive read as text is
 * corrupted. What the version holds is decided by `reviseDocument`, the same
 * rule `update_document` follows: an archive replaces the bundle, one file
 * replaces the entry and keeps the rest (SPEC §19).
 *
 * It takes the real editor set, not open editing. Uploading a bundle into
 * somebody's document is a re-upload in all but name, and open editing exists
 * for correcting text in place, not for replacing what a document is made of.
 */
async function updateFromUpload(
  req: Request,
  res: import("express").Response,
  caller: Principal,
  docId: string,
  input: ({ extracted: ExtractedBundle; extra?: ListedFile[] } | { overlay: { files: Array<BundleEntry | ListedFile>; byName: boolean } }) & {
    staged?: { bucket: StagingBucket; files: StagedFile[] };
  },
): Promise<void> {
  if (strParam(req, "id") || strParam(req, "folderId") || strParam(req, "title")) {
    badRequest(res, "an update keeps the document's address, folder and title");
    return;
  }
  if (!safeSegment(docId)) {
    badRequest(res, "invalid update");
    return;
  }
  const docRef = db().collection("docs").doc(docId);
  const snap = await docRef.get();
  if (!snap.exists) {
    res.status(404).end();
    return;
  }
  const data = snap.data() as DocAclData & { currentVersion?: string; title?: string };
  if (!isDocEditor(data, caller.uid, caller.emailLower)) {
    const proof = await linkProofFor(docRef, data, caller, strParam(req, "k"));
    res.status(refusal(data, caller, proof)).end();
    return;
  }
  const frozen = frozenWrite(data, Date.now());
  if (frozen) {
    res.status(409).json(frozen);
    return;
  }
  // The version the caller revised from, when it says, as update_document
  // takes it: refused if another is current, rather than replacing that one.
  const revisedFrom = strParam(req, "baseVersion");
  const current = String(data.currentVersion ?? "");
  if (revisedFrom && revisedFrom !== current) {
    res.status(409).json({
      error: `the document is at ${current} now, not ${revisedFrom}: somebody published since you read it. Read it again, then update that`,
      currentVersion: current,
    });
    return;
  }

  const actor = actorFrom(caller, req);
  const result = await reviseDocument({
    db: db(),
    docRef,
    baseVersion: String(data.currentVersion ?? ""),
    title: String(data.title ?? docId),
    ...input,
    actor,
    authorEmail: caller.emailLower,
    editorsOnly: true,
  }).catch((e: Error) => e);

  if (result instanceof Error) {
    res.status(500).json({ error: "could not publish the new version" });
    return;
  }
  if ("status" in result) {
    // Pending suggestions, or another version made current during the upload.
    const { status, ...refusal } = result;
    res.status(status).json(refusal);
    return;
  }
  if ("error" in result) {
    badRequest(res, result.error);
    return;
  }
  res.status(200).json({ docId, ...result });
}

/** The most staged uploads one publish may name. */
const MAX_STAGED = 20;

/** Every value of a repeatable query parameter. */
function listParam(req: Request, key: string): string[] {
  const v = (req.query as Record<string, unknown>)[key];
  const all = Array.isArray(v) ? v : v === undefined ? [] : [v];
  return all.filter((x): x is string => typeof x === "string" && x.length > 0);
}

/**
 * Files the document already stores, which the client did not send again:
 * `have=<path>:<sha256>`, each checked against the document's own stored
 * files (SPEC §24). Naming one is safe: whoever may update a document may
 * read every version of it, and the update is checked for that below.
 */
async function readHaves(docId: string, haves: readonly string[]): Promise<{ files: ListedFile[] } | { error: string }> {
  const files: ListedFile[] = [];
  for (const h of haves) {
    const at = h.lastIndexOf(":");
    const rel = at > 0 ? safeBundleRelPath(h.slice(0, at)) : null;
    const sha256 = h.slice(at + 1);
    if (!rel || !/^[0-9a-f]{64}$/.test(sha256) || !safeSegment(docId)) return { error: `not a file this document stores: ${h}` };
    try {
      const [meta] = await bucket().file(blobKey(docId, sha256)).getMetadata();
      files.push({ rel, size: Number(meta.size), sha256 });
    } catch {
      return { error: `this document does not store ${rel} as sent; send the file itself` };
    }
  }
  return { files };
}

/**
 * POST /media — a session to send one large picture, film or recording
 * straight to Storage (SPEC §2, §24, ADR 0037). `{docId?, k?, path, size,
 * sha256?}`. With `docId`, only an editor of that document may open one, and
 * a `sha256` the document already stores answers `{have: true}`: nothing
 * needs sending. Without it, the session is for a document not made yet.
 */
async function openMediaSession(req: Request, res: import("express").Response, caller: Principal): Promise<void> {
  const body = (jsonBody(req) ?? {}) as Record<string, unknown>;
  const checked = checkSessionRequest(body);
  if ("error" in checked) {
    badRequest(res, checked.error);
    return;
  }
  const docId = typeof body.docId === "string" && body.docId ? body.docId : null;
  if (docId) {
    if (!safeSegment(docId)) {
      res.status(404).end();
      return;
    }
    const docRef = db().collection("docs").doc(docId);
    const snap = await docRef.get();
    const data = snap.data() as DocAclData | undefined;
    if (!snap.exists || !data) {
      res.status(404).end();
      return;
    }
    if (!isDocEditor(data, caller.uid, caller.emailLower)) {
      const proof = await linkProofFor(docRef, data, caller, typeof body.k === "string" ? body.k : null);
      res.status(refusal(data, caller, proof)).end();
      return;
    }
    const frozen = frozenWrite(data, Date.now());
    if (frozen) {
      res.status(409).json(frozen);
      return;
    }
    if (checked.sha256) {
      const [stored] = await bucket().file(blobKey(docId, checked.sha256)).exists();
      if (stored) {
        res.status(200).json({ have: true });
        return;
      }
    }
  }
  const session = await openSession({
    bucket: bucket() as unknown as StagingBucket,
    uid: caller.uid,
    docId,
    path: checked.path,
    size: checked.size,
    // A browser's session answers Storage's CORS check for this deployment
    // only; a token's needs none. Never taken from the request.
    origin: caller.tokenId ? null : publicOrigin(),
  });
  res.status(200).json({ ...session, chunkBytes: UPLOAD_CHUNK_BYTES });
}

/** A JSON-encoded query parameter, for structured metadata on a binary upload. */
function jsonParam(req: Request, key: string): unknown {
  const raw = strParam(req, key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** POST /folder — create a folder. `{ name, parentId? }`. */
export const createFolder = onRequest(PLAIN, async (req, res) => {
  if (rejectMethod(req, res, ["POST"])) return;
  const caller = await resolveCaller(req);
  if (!caller) {
    res.status(401).end();
    return;
  }

  const body = jsonBody(req) as { name?: unknown; parentId?: unknown } | null;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 120) {
    badRequest(res, "folder name is required (up to 120 characters)");
    return;
  }
  const parent = await resolveFolderTarget(db(), body?.parentId, caller);
  if (!parent.ok) {
    res.status(parent.status).json({ error: parent.error });
    return;
  }

  res.status(200).json(await createFolderRecord(db(), caller, name, parent));
});

/** GET inherited grants; POST owner-only folder sharing and subtree recomputation. */
export const setFolderAccess = onRequest(MAILING, async (req, res) => {
  noStore(res);
  if (rejectMethod(req, res, ["GET", "POST"])) return;
  const caller = await resolveCaller(req);
  if (!caller) { res.status(401).end(); return; }
  const body = jsonBody(req) as Record<string, unknown> | null;
  const id = req.method === "GET" ? strParam(req, "folderId") : typeof body?.folderId === "string" ? body.folderId : "";
  const ctx = { db: db(), caller, actor: actorFrom(caller, req) };
  try {
    const result = req.method === "GET" ? await getAccess(ctx, "folder", id) : await changeAccess(ctx, "folder", id, body);
    res.status(200).json(req.method === "GET" ? { inherited: result.inherited, inheritedReach: result.inheritedReach } : result.direct);
  } catch (error) { managementFailure(error, res); }
});

/**
 * POST /organize — move, rename, trash or restore a document or folder.
 *
 * `trash` and `restore` are the owner's alone (SPEC §4): a folder goes with
 * everything in it, other people's documents too, and each owner restores
 * their own. Nothing here deletes anything forever: that is POST /purge,
 * from the browser only, and the daily job. `delete` on a folder is `trash`,
 * the word the CLI before 0.20 sends; on a document it is refused and says
 * to trash it.
 */
export const organize = onRequest(PLAIN, async (req, res) => {
  noStore(res);
  if (rejectMethod(req, res, ["POST"])) return;
  const caller = await resolveCaller(req);
  if (!caller) {
    res.status(401).end();
    return;
  }

  const body = jsonBody(req) as {
    kind?: unknown;
    id?: unknown;
    op?: unknown;
    targetFolderId?: unknown;
    name?: unknown;
  } | null;
  const kind = body?.kind === "doc" || body?.kind === "folder" ? body.kind : "";
  const id = typeof body?.id === "string" ? body.id : "";
  const op =
    body?.op === "move" || body?.op === "rename" || body?.op === "delete" || body?.op === "trash" || body?.op === "restore" ? body.op : "";
  if (!kind || !id || !safeSegment(id) || !op) {
    badRequest(res, "invalid kind/id/op");
    return;
  }

  // Before the edit checks below: a trashed document is frozen, and the
  // owner restoring it is the one write that thaws it.
  if (op === "trash" || op === "restore" || (op === "delete" && kind === "folder")) {
    const ctx = { db: db(), caller, actor: actorFrom(caller, req) };
    try {
      const result = kind === "doc"
        ? op === "restore" ? await restoreDocument(ctx, id) : await trashDocument(ctx, id)
        : op === "restore" ? await restoreFolder(ctx, id) : await trashFolder(ctx, id);
      res.status(200).json({ ok: true, ...result });
    } catch (error) { managementFailure(error, res); }
    return;
  }

  const { emailLower } = caller;

  if (kind === "doc") {
    const ref = db().collection("docs").doc(id);
    const snap = await ref.get();
    if (!snap.exists) {
      res.status(404).end();
      return;
    }
    const data = snap.data() as DocAclData & {
      viewers?: unknown;
      editors?: unknown;
      ownerEmail?: string;
    };
    const proof = await linkProofFor(ref, data, caller, null);
    if (!canEdit(data, caller, proof)) {
      res.status(refusal(data, caller, proof)).end();
      return;
    }

    const frozen = frozenWrite(data, Date.now());
    if (frozen) {
      res.status(409).json(frozen);
      return;
    }

    if (op === "delete") {
      badRequest(res, "a document is not deleted: move it to the Trash with op \"trash\"");
      return;
    }
    if (op === "rename") {
      const renamed = await renameDocument(db(), ref, body?.name, actorFrom(caller, req));
      if ("error" in renamed) {
        badRequest(res, renamed.error);
        return;
      }
      res.status(200).json({ ok: true });
      return;
    }

    // Moving is SHARING, not editing. Filing a document into a folder makes
    // that folder's members its members, and its link and public level reach
    // it, so whoever may move a document decides who may read it. That is the
    // owner's alone, as setAccess is: an editor who could file the owner's
    // private document into their own folder could then share or publish that
    // folder, and became an approver of it besides (SPEC §13, §19).
    if (!canManageSharing(data, emailLower)) {
      res.status(403).json({ error: MOVE_IS_SHARING });
      return;
    }
    const target = await resolveFolderTarget(db(), body?.targetFolderId, caller);
    if (!target.ok) {
      res.status(target.status).json({ error: target.error });
      return;
    }
    const was = (data as { folderId?: unknown }).folderId;
    const fromFolder = typeof was === "string" ? was : null;
    await persistDocMembership(
      db(),
      ref,
      () => ({ folderId: target.id }),
      () =>
        fromFolder === target.id
          ? []
          : [{ type: "doc.moved", audience: "editors", actor: eventActor(actorFrom(caller, req)), data: { from: fromFolder, to: target.id } }],
    );
    res.status(200).json({ ok: true });
    return;
  }

  // A folder's delete went to the Trash above.
  if (op !== "rename" && op !== "move") {
    badRequest(res, "invalid kind/id/op");
    return;
  }
  try {
    await organizeFolder({ db: db(), caller, actor: actorFrom(caller, req) }, id, op, {
      name: body?.name, parent: body?.targetFolderId,
    });
    res.status(200).json({ ok: true });
  } catch (error) { managementFailure(error, res); }
});

/**
 * POST /fork — `{ op: "create" | "lineage", docId, k?, ... }` (SPEC §21).
 *
 * `create` copies a version the caller can READ into a new private document
 * they own: `{ versionId?, folderId?, title? }`, answering
 * `{ docId, versionId, title }`. `lineage` answers where a document came from,
 * as far as the caller may see, and its forks for its owner.
 *
 * Both answer per caller, so neither may be cached: `noStore` comes first.
 */
export const forkDoc = onRequest(PLAIN, async (req, res) => {
  noStore(res);
  if (rejectMethod(req, res, ["POST"])) return;
  const caller = await resolveCaller(req);
  if (!caller) {
    res.status(401).end();
    return;
  }

  const body = jsonBody(req) as {
    op?: unknown;
    docId?: unknown;
    k?: unknown;
    versionId?: unknown;
    folderId?: unknown;
    title?: unknown;
  } | null;
  const op = body?.op === "create" || body?.op === "lineage" ? body.op : "";
  const docId = typeof body?.docId === "string" ? body.docId : "";
  if (!op || !docId || !safeSegment(docId)) {
    badRequest(res, "invalid op or docId");
    return;
  }
  const k = typeof body?.k === "string" ? body.k : null;

  if (op === "lineage") {
    const out = await lineageFor({ db: db(), caller, docId, k });
    if (!out.ok) {
      res.status(out.status).end();
      return;
    }
    res.status(200).json(out.lineage);
    return;
  }

  let out: Awaited<ReturnType<typeof forkDocument>>;
  try {
    out = await forkDocument({
      db: db(),
      bucket: bucket(),
      caller,
      actor: actorFrom(caller, req),
      sourceId: docId,
      k,
      versionId: typeof body?.versionId === "string" ? body.versionId : null,
      folderId: body?.folderId,
      title: body?.title,
    });
  } catch {
    res.status(500).json({ error: "could not create the fork" });
    return;
  }
  if (!out.ok) {
    // A refused read is the bare 404 an absent id gets (SPEC §1.4b). A folder
    // that is not there is a 404 too, but about the request, so it says so.
    if (out.unreadable) res.status(404).end();
    else res.status(out.status).json({ error: out.error });
    return;
  }
  res.status(200).json({ docId: out.docId, versionId: out.versionId, title: out.title });
});
