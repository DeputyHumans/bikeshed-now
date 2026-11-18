// SPDX-License-Identifier: Apache-2.0
// Inline editing: the draft, reading it back, and committing it (SPEC §2, §16).

import { versionStoragePrefix } from "../lib/storage";
import { onRequest } from "firebase-functions/v2/https";
import { parseCausalStamp, readStoredCausalStamp } from "../lib/causal";
import { MAX_BUNDLE_BYTES } from "../config";
import { canEdit, frozenWrite, type DocAclData } from "../lib/acl";
import { actorFrom, resolveCaller } from "../lib/actor";
import { linkProofFor } from "../lib/linkgrant";
import {
  commitDraft,
  DraftConflict,
  draftRevision,
  loadVersionMeta,
  versionKey,
  writeDraft,
} from "../lib/draft";
import { WriteAuthorityError } from "../lib/writeAuthority";
import { renderMarkdown } from "../lib/markdown/render";
import { htmlToMarkdown } from "../lib/markdown/serialize";
import { isServiceWorkerFetch } from "../lib/scriptlock";
import {
  badRequest,
  jsonBody,
  noStore,
  pathSegments,
  rejectMethod,
  safeRelPath,
  safeSegment,
  strParam,
} from "../lib/http";
import { db, bucket, refusal, PLAIN } from "./runtime";
import { redirectToMedia, setScriptLock, streamObject } from "./content";

// ---------------------------------------------------------------------------
// Inline editing: draft, draft read-back, commit
// ---------------------------------------------------------------------------

/**
 * POST /draft — persist the edited entry as the shared draft.
 *
 * For a Markdown-sourced document the posted HTML is converted back to Markdown
 * HERE and both files are written: the source, which is canonical, and a freshly
 * rendered HTML so the draft read-back below needs no special case (SPEC §11).
 */
export const saveDraft = onRequest(PLAIN, async (req, res) => {
  if (rejectMethod(req, res, ["POST"])) return;
  const caller = await resolveCaller(req);
  if (!caller) {
    res.status(401).end();
    return;
  }

  const body = jsonBody(req) as {
    docId?: unknown;
    baseVersion?: unknown;
    html?: unknown;
    liveEpoch?: unknown;
    draftRevision?: unknown;
    causal?: unknown;
  } | null;
  const docId = typeof body?.docId === "string" ? body.docId : "";
  if (!docId || !safeSegment(docId)) {
    badRequest(res, "invalid or missing docId");
    return;
  }
  const baseVersion = typeof body?.baseVersion === "string" ? body.baseVersion : "";
  if (!baseVersion || !safeSegment(baseVersion)) {
    badRequest(res, "invalid or missing baseVersion");
    return;
  }
  const liveEpoch = body?.liveEpoch;
  if (liveEpoch !== undefined && (typeof liveEpoch !== "string" || !safeSegment(liveEpoch))) {
    badRequest(res, "invalid liveEpoch"); return;
  }
  const expectedRevision = body?.draftRevision;
  if (expectedRevision !== undefined && (typeof expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(expectedRevision))) {
    badRequest(res, "invalid draftRevision"); return;
  }
  const causal = body?.causal === undefined ? undefined : parseCausalStamp(body.causal);
  if (causal === null || (causal !== undefined && liveEpoch === undefined)) {
    badRequest(res, "invalid causal history or missing liveEpoch"); return;
  }
  const html = typeof body?.html === "string" ? body.html : "";
  if (html.trim().length === 0) {
    badRequest(res, "html is empty");
    return;
  }
  if (Buffer.byteLength(html, "utf8") > MAX_BUNDLE_BYTES) {
    badRequest(res, "draft too large");
    return;
  }

  const ref = db().collection("docs").doc(docId);
  const snap = await ref.get();
  if (!snap.exists) {
    res.status(404).end();
    return;
  }
  const data = snap.data() as DocAclData & {
    title?: string;
    currentVersion?: string;
    draft?: { editSessions?: unknown } | null;
  };
  const proof = await linkProofFor(ref, data, caller, null);
  if (!canEdit(data, caller, proof)) {
    res.status(refusal(data, caller, proof)).end();
    return;
  }
  // Refused for the OWNER too: an expired or trashed document is frozen, and
  // lifting the date or restoring it is what thaws it. One action, rather than
  // a special case here.
  const frozen = frozenWrite(data, Date.now());
  if (frozen) {
    res.status(409).json(frozen);
    return;
  }
  if (data.currentVersion !== baseVersion) {
    res.status(409).json({
      error: "This document has a newer version. Reload before editing.",
      currentVersion: data.currentVersion,
    });
    return;
  }

  const version = await loadVersionMeta(ref, baseVersion);
  if (!version) {
    badRequest(res, "could not resolve a safe entry path");
    return;
  }

  // For Markdown the posted HTML is converted back to Markdown HERE, and its
  // rendering stored beside it (SPEC §11).
  const markdown = version.format === "markdown" ? htmlToMarkdown(html) : null;
  let draft;
  try {
    draft = await writeDraft({
      db: db(),
      docRef: ref,
      baseVersion,
      liveEpoch,
      causal,
      // Unclocked writers replace a whole snapshot, so they must not overwrite
      // any newer save. Legacy API callers still get request-time CAS.
      ...(!causal ? (expectedRevision === undefined ? { expectedDraft: data.draft } : { expectedRevision }) : {}),
      retireLive: !causal,
      version,
      content:
        markdown === null ? { html } : { markdown, html: renderMarkdown(markdown, { title: data.title }).html },
      emailLower: caller.emailLower,
      actor: actorFrom(caller, req),
    });
  } catch (error) {
    if (error instanceof WriteAuthorityError) { res.status(error.status).json(error.detail); return; }
    if (error instanceof DraftConflict) { res.status(409).json(error.detail); return; }
    throw error;
  }

  res.status(200).json({ draft: { ...draft, editSessions: undefined } });
});

/**
 * GET /draft/:docId/<relpath, default entry> — the shared draft.
 *
 * Falls back to the base version for any path the draft prefix does not carry,
 * so a first edit and every non-entry asset still render.
 */
export const getDraft = onRequest(PLAIN, async (req, res) => {
  if (rejectMethod(req, res, ["GET", "HEAD"])) return;
  noStore(res); // before any branch can return — see noStore()
  // Even empty refusals must not look like editable HTML to the parent frame.
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (isServiceWorkerFetch(req.get("service-worker"))) {
    res.status(404).end();
    return;
  }
  const caller = await resolveCaller(req);
  if (!caller) {
    res.status(401).end();
    return;
  }

  const segments = pathSegments(req, "draft");
  if (!segments || segments.length < 1) {
    res.status(404).end();
    return;
  }
  const docId = segments[0];

  const docSnap = await db().collection("docs").doc(docId).get();
  if (!docSnap.exists) {
    res.status(404).end();
    return;
  }
  const docData = docSnap.data() as DocAclData & {
    currentVersion?: string;
    liveEpoch?: string;
    draft?: { baseVersion?: string; entry?: string; sourceEntry?: string; storagePrefix?: string; causal?: unknown } | null;
  };
  const proof = await linkProofFor(docSnap.ref, docData, caller, null);
  if (!canEdit(docData, caller, proof)) {
    res.status(refusal(docData, caller, proof)).end();
    return;
  }
  const frozen = frozenWrite(docData, Date.now());
  if (frozen) {
    res.status(409).json(frozen);
    return;
  }

  const hasDraft = docData.draft?.baseVersion === docData.currentVersion;
  const baseVersion = docData.currentVersion;
  if (typeof baseVersion !== "string" || !safeSegment(baseVersion)) {
    res.status(404).end();
    return;
  }

  const revision = draftRevision(docData);
  const liveEpoch = docData.liveEpoch ?? "initial";
  const requestedBase = strParam(req, "baseVersion");
  const requestedEpoch = strParam(req, "liveEpoch");
  const requestedRevision = strParam(req, "draftRevision");
  if ((requestedBase && requestedBase !== baseVersion) ||
      (requestedEpoch && requestedEpoch !== liveEpoch) ||
      (requestedRevision && requestedRevision !== revision)) {
    res.status(409).json({ error: "The draft changed. Reload before editing.", draftChanged: true });
    return;
  }
  if (strParam(req, "session") === "1") {
    const version = await loadVersionMeta(docSnap.ref, baseVersion);
    if (!version) { res.status(404).end(); return; }
    const causal = hasDraft ? readStoredCausalStamp(docData.draft?.causal) : null;
    res.status(200).json({ baseVersion, liveEpoch, draftRevision: revision, entry: version.entry, ...(causal ? { causal } : {}) });
    return;
  }

  let relPath = segments.slice(1).join("/");
  if (relPath.length === 0) {
    const version = await loadVersionMeta(docSnap.ref, baseVersion);
    const entry = (hasDraft ? docData.draft?.entry : undefined) ?? version?.entry;
    if (typeof entry !== "string" || safeRelPath(entry) == null) {
      res.status(404).end();
      return;
    }
    relPath = entry;
  }

  const draftKey = `${versionStoragePrefix(docId, "draft", docData.draft ?? {})}/${relPath}`;
  const version = await loadVersionMeta(docSnap.ref, baseVersion);
  if (!version) { res.status(404).end(); return; }
  const baseKey = versionKey(docId, version, relPath);
  let objectKey = draftKey;
  const [draftExists] = hasDraft ? await bucket().file(draftKey).exists() : [false];
  if (hasDraft && !draftExists && (relPath === docData.draft?.entry || relPath === docData.draft?.sourceEntry)) {
    res.status(409).json({ error: "The draft changed. Reload to read its current snapshot.", draftChanged: true });
    return;
  }
  if (!draftExists) {
    if (!baseKey) {
      res.status(404).end();
      return;
    }
    objectKey = baseKey;
    const [baseExists] = await bucket().file(baseKey).exists();
    if (!baseExists) {
      res.status(404).end();
      return;
    }
  }

  // A video or a recording the version holds plays in the editor as it does
  // for readers, from a short-lived Storage link (SPEC §24).
  if (await redirectToMedia(res, objectKey, relPath)) return;
  res.setHeader("Cache-Control", "private, no-store");
  // A draft's script never runs, for anyone: any editor may have written it,
  // and it is nobody's published word yet (ADR 0021).
  setScriptLock(res, relPath, { asked: false, granted: false });
  await streamObject(res, objectKey, relPath, req.method === "HEAD", true);
});

/**
 * POST /commit — promote the draft into a new immutable version.
 *
 * Mirrors the publish CLI exactly: assemble, hash with the frozen framing,
 * DEDUP on contentHash, upload, then one transaction that writes the version and
 * moves the pointer. Identical bytes are a no-op, which is what makes publishing
 * safe to retry and safe for an agent that cannot remember what it already did.
 */
export const commitVersion = onRequest(PLAIN, async (req, res) => {
  if (rejectMethod(req, res, ["POST"])) return;
  const caller = await resolveCaller(req);
  if (!caller) {
    res.status(401).end();
    return;
  }

  const body = jsonBody(req) as { docId?: unknown; baseVersion?: unknown } | null;
  const docId = typeof body?.docId === "string" ? body.docId : "";
  if (!docId || !safeSegment(docId)) {
    badRequest(res, "invalid or missing docId");
    return;
  }
  const baseVersion = typeof body?.baseVersion === "string" ? body.baseVersion : "";
  if (!baseVersion || !safeSegment(baseVersion)) {
    badRequest(res, "invalid or missing baseVersion");
    return;
  }

  const docRef = db().collection("docs").doc(docId);
  const snap = await docRef.get();
  if (!snap.exists) {
    res.status(404).end();
    return;
  }
  const data = snap.data() as DocAclData & {
    currentVersion?: string;
    draft?: { entry?: string; editSessions?: unknown } | null;
  };
  const proof = await linkProofFor(docRef, data, caller, null);
  if (!canEdit(data, caller, proof)) {
    res.status(refusal(data, caller, proof)).end();
    return;
  }
  // Refused for the OWNER too: an expired or trashed document is frozen, and
  // lifting the date or restoring it is what thaws it. One action, rather than
  // a special case here.
  const frozen = frozenWrite(data, Date.now());
  if (frozen) {
    res.status(409).json(frozen);
    return;
  }
  if (data.currentVersion !== baseVersion) {
    res.status(409).json({
      error: "This document has a newer version. Reload before publishing.",
      currentVersion: data.currentVersion,
    });
    return;
  }
  const outcome = await commitDraft({
    db: db(),
    docRef,
    baseVersion,
    draft: data.draft,
    emailLower: caller.emailLower,
    actor: actorFrom(caller, req),
  });
  res.status(outcome.status).json(outcome.body);
});
