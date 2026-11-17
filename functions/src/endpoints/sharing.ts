// SPDX-License-Identifier: Apache-2.0
// Who may read a document: access, visibility, trust and marking (SPEC §2, §13, §17, §20).

import { onRequest } from "firebase-functions/v2/https";
import { superadmins } from "../config";
import {
  getAccess,
  setAccess as changeAccess,
  setVisibility as changeVisibility,
  setFolderVisibility as changeFolderVisibility,
  ManagementError,
} from "../lib/management";
import { canManageSharing, frozenWrite, isTrashed, type DocAclData } from "../lib/acl";
import { parseExpiry } from "../lib/access";
import { actorFrom, resolveCaller } from "../lib/actor";
import { linkProofFor } from "../lib/linkgrant";
import { syncPublicProjection } from "../lib/publicdoc";
import { addEvent, eventActor } from "../lib/events";
import { resolveMarking, type Marking } from "../lib/marking";
import { canTrustForEveryone, globallyTrusted } from "../lib/scriptlock";
import { badRequest, jsonBody, noStore, rejectMethod, safeSegment, strParam } from "../lib/http";
import { db, now, refusal, MAILING, PLAIN } from "./runtime";

// ---------------------------------------------------------------------------
// Sharing, visibility, trust, marking
// ---------------------------------------------------------------------------

export function asArray(v: unknown): string[] {
  return Array.isArray(v) ? (v as string[]) : [];
}

/** Errors shared by HTTP and MCP, with no resource existence disclosure. */
export function managementFailure(error: unknown, res: import("express").Response): void {
  if (error instanceof ManagementError && (error.status === 404 || error.status === 403)) { res.status(error.status).end(); return; }
  if (error instanceof ManagementError) { res.status(error.status).json({ ...error.detail, error: error.message }); return; }
  throw error;
}

/** GET inherited grants; POST a direct grant delta (SPEC §2, §13). */
export const setAccess = onRequest(MAILING, async (req, res) => {
  noStore(res);
  if (rejectMethod(req, res, ["GET", "POST"])) return;
  const caller = await resolveCaller(req);
  if (!caller) { res.status(401).end(); return; }
  const body = jsonBody(req) as Record<string, unknown> | null;
  const id = req.method === "GET" ? strParam(req, "docId") : typeof body?.docId === "string" ? body.docId : "";
  const ctx = { db: db(), caller, actor: actorFrom(caller, req) };
  try {
    const result = req.method === "GET" ? await getAccess(ctx, "document", id) : await changeAccess(ctx, "document", id, body);
    res.status(200).json(req.method === "GET" ? { inherited: result.inherited, inheritedReach: result.inheritedReach } : { ...result.direct, members: result.effective.members });
  } catch (error) { managementFailure(error, res); }
});

/**
 * A sparse patch for the date, as MCP's is: a body that names no `expiresAt`
 * leaves the stored one alone, and explicit `null` clears it (SPEC §2). The
 * level and open editing are still sent whole. `{ folderId }` in place of
 * `docId` sets a folder's own level and expiry, which is what its reach opens
 * beneath it (SPEC §13, §17).
 *
 * Only a date that is sent is parsed. A past one is refused (`parseExpiry`), so
 * a dialog that echoed back a date which has since passed could change nothing
 * else on the record until somebody cleared it.
 */
export const setVisibility = onRequest(PLAIN, async (req, res) => {
  noStore(res);
  if (rejectMethod(req, res, ["POST"])) return;
  const caller = await resolveCaller(req);
  if (!caller) { res.status(401).end(); return; }
  const body = jsonBody(req) as Record<string, unknown> | null;
  const expiry = body !== null && typeof body === "object" && Object.hasOwn(body, "expiresAt") ? parseExpiry(body.expiresAt) : null;
  if (expiry && "error" in expiry) { badRequest(res, expiry.error); return; }
  const datePatch = expiry ? { expiresAt: expiry.value } : {};
  if (body?.docId === undefined && body?.folderId !== undefined) {
    const folderId = typeof body.folderId === "string" ? body.folderId : "";
    try {
      const result = await changeFolderVisibility({ db: db(), caller, actor: actorFrom(caller, req) }, folderId, {
        visibility: body.visibility, ...datePatch,
      });
      const { visibility, linkToken, expiresAt } = result;
      res.status(200).json({ visibility, linkToken, expiresAt });
    } catch (error) { managementFailure(error, res); }
    return;
  }
  const id = typeof body?.docId === "string" ? body.docId : "";
  try {
    const result = await changeVisibility({ db: db(), caller, actor: actorFrom(caller, req) }, id, {
      visibility: body?.visibility, publicEdit: body?.publicEdit === true,
      ...datePatch,
    });
    const { visibility, publicEdit, linkToken, expiresAt } = result;
    res.status(200).json({ visibility, publicEdit, linkToken, expiresAt });
  } catch (error) { managementFailure(error, res); }
});

/**
 * POST /trust — lift (or restore) the untrusted-content sandbox for everyone.
 * GET /trust?docId= — what the trust dialog may offer this caller.
 *
 * Lifting it lets the document's own JavaScript run same-origin for EVERY
 * reader, which lets its author act as each of them. So it is no longer the
 * owner's call alone: only a superadmin (`BIKESHED_SUPERADMINS`, deployment
 * configuration) who owns the document may lift it (ADR 0021). Restoring the
 * sandbox stays the owner's, because it only ever takes a power away. The
 * per-account opt-in is a client write to docs/{docId}/trust/{uid} and never
 * touches this flag (SPEC §6c).
 */
export const trustDoc = onRequest(PLAIN, async (req, res) => {
  if (rejectMethod(req, res, ["GET", "POST"])) return;
  noStore(res);
  const caller = await resolveCaller(req);
  if (!caller) {
    res.status(401).end();
    return;
  }

  const body = req.method === "POST" ? (jsonBody(req) as { docId?: unknown; trusted?: unknown } | null) : null;
  const docId = req.method === "POST" ? (typeof body?.docId === "string" ? body.docId : "") : strParam(req, "docId");
  if (!docId || !safeSegment(docId)) {
    badRequest(res, "invalid or missing docId");
    return;
  }

  const ref = db().collection("docs").doc(docId);
  const snap = await ref.get();
  if (!snap.exists) {
    res.status(404).end();
    return;
  }
  const data = snap.data() as DocAclData;
  if (!canManageSharing(data, caller.emailLower)) {
    res.status(refusal(data, caller, await linkProofFor(ref, data, caller, null))).end();
    return;
  }
  // Only the browser's session lifts the sandbox for everyone. A token is a
  // credential an agent may hold, acting on text it was given, and lifting the
  // sandbox lets the document's author act as every reader: the decision is
  // as final as deleting forever, which refuses every token too.
  const mayLift = canTrustForEveryone(data, caller.emailLower, superadmins()) && caller.channel === "web";

  if (req.method === "GET") {
    res.status(200).json({ trusted: globallyTrusted(data), canTrustForEveryone: mayLift });
    return;
  }

  // Expiry does not stop this (lifting the sandbox is not an edit); the Trash
  // does, because nothing but Restore changes a trashed document.
  if (isTrashed(data)) {
    res.status(409).json(frozenWrite(data, Date.now()));
    return;
  }
  const trusted = body?.trusted !== false;
  if (trusted && caller.channel !== "web") {
    res.status(403).json({ error: TRUST_FROM_BROWSER_ONLY });
    return;
  }
  if (trusted && !mayLift) {
    res.status(403).json({ error: TRUST_FOR_EVERYONE_REFUSED });
    return;
  }

  const batch = db().batch();
  batch.set(ref, { trusted, updatedAt: now() }, { merge: true });
  if ((data as { trusted?: unknown }).trusted !== trusted) {
    addEvent(batch, ref, { type: "doc.trust", audience: "editors", actor: eventActor(actorFrom(caller, req)), data: { trusted } });
  }
  await batch.commit();
  await syncPublicProjection(db(), docId);
  res.status(200).json({ trusted });
});

/** Why only an owner may move a document or folder: it changes who can read it. */
export const MOVE_IS_SHARING =
  "Only its owner can move this: moving it into or out of a folder changes who can read it.";

/** What a token is told when it tries to lift the sandbox: restoring it is still allowed. */
const TRUST_FROM_BROWSER_ONLY =
  "Running a document's code for everyone is decided in the browser, by one of this deployment's administrators. A token, an agent's included, can sandbox a document again but never lift it.";

/** What an owner who is not a superadmin is told when they try to trust for everyone. */
const TRUST_FOR_EVERYONE_REFUSED =
  "Only this deployment's administrators can run a document's code for everyone. Each reader can still choose to run it for themselves.";

/**
 * POST /marking — owner-only export marking. `{ docId, marking }`.
 *
 * Authoritative at export time. Resolved and clamped here so the values a stamp
 * is built from are already bounded and free of control characters (SPEC §20).
 */
export const setMarking = onRequest(PLAIN, async (req, res) => {
  if (rejectMethod(req, res, ["POST"])) return;
  const caller = await resolveCaller(req);
  if (!caller) {
    res.status(401).end();
    return;
  }

  const body = jsonBody(req) as { docId?: unknown; marking?: unknown } | null;
  const docId = typeof body?.docId === "string" ? body.docId : "";
  if (!docId || !safeSegment(docId)) {
    badRequest(res, "invalid or missing docId");
    return;
  }
  const marking: Marking = resolveMarking(body?.marking);

  const ref = db().collection("docs").doc(docId);
  const snap = await ref.get();
  if (!snap.exists) {
    res.status(404).end();
    return;
  }
  const data = snap.data() as DocAclData;
  if (!canManageSharing(data, caller.emailLower)) {
    res.status(refusal(data, caller, await linkProofFor(ref, data, caller, null))).end();
    return;
  }

  if (isTrashed(data)) {
    res.status(409).json(frozenWrite(data, Date.now()));
    return;
  }
  await ref.set({ marking, updatedAt: now() }, { merge: true });
  await syncPublicProjection(db(), docId);
  res.status(200).json({ marking });
});
