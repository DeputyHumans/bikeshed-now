// SPDX-License-Identifier: Apache-2.0
// Reading statistics: the activity feed, view heartbeats and unlocking (SPEC §2, §15).

import { onRequest, type Request } from "firebase-functions/v2/https";
import { FieldValue } from "firebase-admin/firestore";
import { MAX_BEAT_MS, MAX_SESSION_MS } from "../config";
import {
  canRead,
  frozenForReader,
  isDocEditor,
  isTrashed,
  tokenMatches,
  type DocAclData,
} from "../lib/acl";
import { listReach, loadReadAccess } from "../lib/reach";
import { actorFrom, isAutomated, resolveCaller } from "../lib/actor";
import { activityPage, decodeFeedCursor } from "../lib/changefeed";
import { linkGrantRef, linkProofFor, grantTokenOf, recordLinkGrant } from "../lib/linkgrant";
import { readerProjection } from "../lib/publicdoc";
import { badRequest, jsonBody, noStore, rejectMethod, safeSegment, strParam } from "../lib/http";
import { db, now, PLAIN } from "./runtime";

// ---------------------------------------------------------------------------
// Reading statistics
// ---------------------------------------------------------------------------

/**
 * GET /activity?docId=…&before=… — one page of a document's Activity panel,
 * newest first: its change log and its reading sessions, each saying who acted
 * and through what (SPEC §17, ADR 0023).
 *
 * Editors only, as the panel always was: who read a document, and how, is a
 * different kind of fact from how many did. Somebody who cannot read the
 * document gets the absent id's 404; a reader who is not an editor, 403.
 */
async function serveActivity(req: Request, res: import("express").Response): Promise<void> {
  noStore(res);
  if (rejectMethod(req, res, ["GET"])) return;
  const caller = await resolveCaller(req);
  if (!caller) { res.status(401).end(); return; }
  const docId = strParam(req, "docId");
  if (!docId || !safeSegment(docId)) { badRequest(res, "invalid or missing docId"); return; }
  const cursor = decodeFeedCursor(strParam(req, "before"));
  if ("error" in cursor) { badRequest(res, cursor.error); return; }

  const docRef = db().collection("docs").doc(docId);
  const data = (await docRef.get()).data();
  if (!data || !canRead(data, caller) || frozenForReader(data, caller)) { res.status(404).end(); return; }
  if (!isDocEditor(data, caller.uid, caller.emailLower)) { res.status(403).end(); return; }
  res.status(200).json(await activityPage(db(), docRef, data, caller, cursor));
}

/** A client-supplied sessionId becomes a document id, so it is opaque and bounded. */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * POST /view — a reading heartbeat.
 *
 * `ms` is the session's ABSOLUTE accumulated active time, never a delta. The
 * server derives the delta itself, so a retried, duplicated or reordered beat is
 * a no-op rather than a double count, and a dropped final beacon costs at most
 * one beat interval.
 *
 * Two branches that matter more than the arithmetic:
 *
 *  - ANONYMOUS readers of a non-private document are counted but never
 *    identified. The session records `uid: null` and is never rolled into
 *    `viewers/{uid}`, because there is no identity to roll into. No IP, no
 *    fingerprint, no unique-visitor estimation: sessions are counted, people are
 *    not (SPEC §17).
 *
 *  - AUTOMATED reads record `ms: 0` into `stats.apiReads` and never touch
 *    `stats.views` or `stats.totalMs`. An agent fetching a document forty times
 *    would otherwise make both meaningless, and reading *time* is not a concept
 *    that applies to a machine fetch at all.
 */
export const recordView = onRequest(PLAIN, async (req, res) => {
  // GET /activity rides on this function, as /thumb's reads ride on
  // contentProxy: one more route, not one more function whose public invoker
  // a deploy could fail to grant without any check noticing (SPEC §2).
  if (req.path === "/activity") {
    await serveActivity(req, res);
    return;
  }
  if (rejectMethod(req, res, ["POST"])) return;
  noStore(res); // before any branch can return — see noStore()
  const caller = await resolveCaller(req);

  const body = jsonBody(req) as {
    docId?: unknown;
    versionId?: unknown;
    sessionId?: unknown;
    ms?: unknown;
    k?: unknown;
    surface?: unknown;
  } | null;
  const docId = typeof body?.docId === "string" ? body.docId : "";
  const versionId = typeof body?.versionId === "string" ? body.versionId : "";
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
  if (!docId || !safeSegment(docId)) {
    badRequest(res, "invalid or missing docId");
    return;
  }
  if (!versionId || !safeSegment(versionId)) {
    badRequest(res, "invalid or missing versionId");
    return;
  }
  if (!SESSION_ID_RE.test(sessionId)) {
    badRequest(res, "invalid or missing sessionId");
    return;
  }
  // The embed page says it is one; the viewer says nothing (SPEC §4). Any
  // other value is a client this server does not know.
  if (body?.surface !== undefined && body.surface !== "embed") {
    badRequest(res, "invalid surface");
    return;
  }
  const embedded = body?.surface === "embed";

  const docRef = db().collection("docs").doc(docId);
  const docSnap = await docRef.get();
  if (!docSnap.exists) {
    res.status(404).end();
    return;
  }
  const docData = docSnap.data() as DocAclData;
  // The same proof the content took: a view of an unlisted document without its
  // key is a view of nothing, and answering otherwise would confirm the id.
  const k = typeof body?.k === "string" ? body.k.trim() : null;
  const proof = await linkProofFor(docRef, docData, caller, k);
  const access = frozenForReader(docData, caller) ? null : await loadReadAccess(db(), docData, caller, proof);
  if (access === null) {
    res.status(404).end();
    return;
  }
  const basis = access.basis;

  const actor = caller ? actorFrom(caller, req) : null;
  const automated = isAutomated(actor);
  // A public folder's reader read a public page; a folder key's, an unlisted one.
  const via: "app" | "unlisted" | "public" =
    basis === "member" ? "app" : basis === "public" || basis === "folder-public" ? "public" : "unlisted";

  const rawMs = typeof body?.ms === "number" && Number.isFinite(body.ms) ? body.ms : 0;
  const claimedMs = automated
    ? 0
    : Math.min(Math.max(0, Math.floor(rawMs)), MAX_SESSION_MS);

  const sessionRef = docRef.collection("views").doc(sessionId);
  const viewerRef = caller ? docRef.collection("viewers").doc(caller.uid) : null;
  // A native retry may follow a successful commit whose acknowledgement was
  // lost. One HTTP beat must not consume another cap on each callback attempt.
  let beatCeiling: number | undefined;

  const result = await db().runTransaction(async (tx) => {
    const sessionSnap = await tx.get(sessionRef);
    const viewerSnap = viewerRef ? await tx.get(viewerRef) : null;

    // A session belongs to whoever opened it. Refuse to extend someone else's.
    const ownerUid = sessionSnap.exists ? (sessionSnap.data()?.uid ?? null) : null;
    if (sessionSnap.exists && ownerUid !== (caller?.uid ?? null)) {
      return { ok: false as const };
    }

    const isNewSession = !sessionSnap.exists;
    const isNewViewer = Boolean(viewerSnap && !viewerSnap.exists);
    const storedMs = isNewSession ? 0 : Number(sessionSnap.data()?.ms ?? 0);
    beatCeiling ??= storedMs + MAX_BEAT_MS;
    const delta = Math.max(0, Math.min(claimedMs, beatCeiling) - storedMs);
    const sessionMs = storedMs + delta;
    // A read is reading: a beat reporting no new time is a tab nobody is looking
    // at, which must not lift a document in Recent or clear "New since you read
    // it". Measured against what was claimed, not `delta`, because a session past
    // its ceiling adds nothing and its reader is still there (SPEC §4).
    const read = isNewSession || isNewViewer || rawMs > storedMs;

    tx.set(
      sessionRef,
      {
        sessionId,
        uid: caller?.uid ?? null,
        email: caller?.emailLower ?? null,
        versionId,
        ms: sessionMs,
        via,
        automated,
        ...(embedded ? { embedded: true } : {}),
        ...(actor ? { actor } : {}),
        ...(isNewSession ? { startedAt: now() } : {}),
        lastBeatAt: now(),
      },
      { merge: true },
    );

    if (viewerRef && caller && !automated) {
      tx.set(
        viewerRef,
        {
          uid: caller.uid,
          email: caller.emailLower,
          views: FieldValue.increment(isNewSession ? 1 : 0),
          totalMs: FieldValue.increment(delta),
          ...(isNewViewer ? { firstViewedAt: now() } : {}),
          ...(read ? { lastViewedAt: now() } : {}),
        },
        { merge: true },
      );
    }

    tx.set(
      docRef,
      {
        stats: {
          // Members receive this map. Reading identities belong only in the
          // editor-gated views/viewers records, including on legacy documents.
          lastViewedByEmail: FieldValue.delete(),
          ...(automated
          ? { apiReads: FieldValue.increment(isNewSession ? 1 : 0) }
          : {
              views: FieldValue.increment(isNewSession ? 1 : 0),
              viewers: FieldValue.increment(isNewViewer ? 1 : 0),
              totalMs: FieldValue.increment(delta),
              // How many of those visits came through an embed: a part of
              // `views`, never added to it.
              ...(embedded ? { embeds: FieldValue.increment(isNewSession ? 1 : 0) } : {}),
              ...(read ? { lastViewedAt: now() } : {}),
            }),
        },
        // `updatedAt` is deliberately NOT touched: it means "bumped on every
        // publish", and a read must not masquerade as a publish.
      },
      { merge: true },
    );

    return { ok: true as const, ms: sessionMs };
  });

  if (!result.ok) {
    res.status(409).json({ error: "sessionId belongs to another reader" });
    return;
  }
  res.status(200).json({ ms: result.ms });
});

/**
 * POST /unlock — what a reader who is not a member is told about a document,
 * and the one place an unlisted document's link is exchanged for access.
 *
 * Body `{ docId, k? }`. 200 with the reader projection (lib/publicdoc.ts) when
 * the caller may read it: a public document, an unlisted one with its key, or
 * an unlisted one this account holds a current link grant for. A signed-in
 * caller who presents the key is granted, because the security rules cannot
 * see a URL and that is how they let a link holder comment (SPEC §17).
 *
 * Everything else is one identical 404: absent, private — to its members too,
 * who read `docs/{docId}` directly — unlisted without the key or with a wrong
 * one, and a grant from before the link was rotated (SPEC §1.4b). The key
 * travels in the body, never the query, so it stays out of request logs.
 *
 * A document a folder's reach opens is answered too, marked `viaFolder`, and
 * never grants: that reader is read-only (ADR 0019). `{ folderId, k? }` in
 * place of `docId` answers what one level of such a folder holds
 * (`lib/reach.ts listReach`), with the same one 404 for every refusal.
 */
export const unlockDoc = onRequest(PLAIN, async (req, res) => {
  if (rejectMethod(req, res, ["POST"])) return;
  noStore(res); // every answer, the 200 included: it may have minted a grant
  const caller = await resolveCaller(req);

  const body = jsonBody(req) as { docId?: unknown; folderId?: unknown; k?: unknown } | null;
  const k = typeof body?.k === "string" ? body.k.trim() : null;
  if (body?.docId === undefined && body?.folderId !== undefined) {
    const folderId = typeof body.folderId === "string" ? body.folderId : "";
    if (!folderId || !safeSegment(folderId)) {
      badRequest(res, "invalid or missing folderId");
      return;
    }
    const listing = await listReach(db(), folderId, k);
    if (!listing) {
      res.status(404).end();
      return;
    }
    res.status(200).json("open" in listing ? listing.open : { ...listing.ended, expired: true });
    return;
  }
  const docId = typeof body?.docId === "string" ? body.docId : "";
  if (!docId || !safeSegment(docId)) {
    badRequest(res, "invalid or missing docId");
    return;
  }

  // The grant is read in the same round trip whether or not the document
  // exists, so how long the answer takes does not say which it was.
  const docRef = db().collection("docs").doc(docId);
  const [docSnap, grantSnap] = caller
    ? await db().getAll(docRef, linkGrantRef(docRef, caller.uid))
    : [await docRef.get(), null];
  if (!docSnap.exists) {
    res.status(404).end();
    return;
  }
  const data = docSnap.data() as DocAclData & Record<string, unknown>;
  // In the Trash: the absent id's 404 for every key and grant, and no new
  // grant. Its owner reads it as a member, never through here (SPEC §4).
  if (isTrashed(data)) {
    res.status(404).end();
    return;
  }
  const access = await loadReadAccess(db(), data, caller, { k, grantToken: grantTokenOf(grantSnap) });
  const projection = access === null ? null : await readerProjection(docRef, data, access);
  if (!projection) {
    res.status(404).end();
    return;
  }

  // Only the document's OWN key grants. A folder's reach never does.
  if (
    access?.basis === "link" &&
    caller &&
    typeof data.linkToken === "string" &&
    !tokenMatches(data.linkToken, grantTokenOf(grantSnap))
  ) {
    await recordLinkGrant(docRef, caller.uid, data.linkToken);
  }
  res.status(200).json(projection);
});
