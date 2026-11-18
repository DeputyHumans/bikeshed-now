// SPDX-License-Identifier: Apache-2.0
// A document's bytes: the content proxy, stored thumbnails and the bundle download (SPEC §2, §6).

import { storedFiles, versionFiles, versionObjectKey, type ListingBucket } from "../lib/storage";
import { isStreamedMedia } from "../lib/files";
import { mediaLink } from "../lib/medialink";
import { onRequest } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import * as mime from "mime-types";
import { randomBytes } from "crypto";
import {
  freshReceiptId,
  readReceipt,
  recordReceipt,
  clearReceipt,
} from "../lib/transaction-receipts";
import { MAX_BUNDLE_BYTES, PUBLIC_CACHE_SECONDS } from "../config";
import {
  earlierEnd,
  expiryMs,
  frozenForReader,
  frozenWrite,
  isDocEditor,
  visibilityOf,
  type DocAclData,
  type ReadAccessBasis,
} from "../lib/acl";
import { loadReadAccess } from "../lib/reach";
import { resolveCaller } from "../lib/actor";
import { CREATE_ONLY } from "../lib/publish";
import {
  THUMB_CACHE_SECONDS,
  THUMB_REL,
  THUMB_REVISION,
  nextThumb,
  parseThumbUpload,
  readThumb,
  servableThumb,
  thumbObjectKey,
  thumbPrefix,
  thumbSlots,
  type ThumbKind,
  type StaleThumbs,
} from "../lib/thumbs";
import { zipBundle, type BundleEntry } from "../lib/bundle";
import { linkProofFor } from "../lib/linkgrant";
import {
  contentSecurityPolicy,
  globallyTrusted,
  isScriptable,
  isServiceWorkerFetch,
} from "../lib/scriptlock";
import {
  badRequest,
  contentPath,
  noStore,
  pathSegments,
  rawBuffer,
  rejectMethod,
  safeSegment,
  strParam,
} from "../lib/http";
import { db, bucket, refusal, PLAIN, WARM } from "./runtime";

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

/** A member's browser may keep these for an hour; nothing else (SPEC §17). */
const CACHEABLE_FOR_MEMBERS = /^(image\/(?!svg)|text\/css$|font\/)/;
const MEMBER_ASSET_SECONDS = 60 * 60;

/** The type a file is served as: by its name, never sniffed. */
export function contentTypeOf(relPath: string): string {
  return mime.lookup(relPath) || "application/octet-stream";
}

/**
 * The script lock for a content or draft response (ADR 0021). Set on every
 * 200 a document path serves, so a scripted document opened any way but the
 * run variant renders inert; the run variant also refuses foreign framing.
 */
export function setScriptLock(
  res: import("express").Response,
  relPath: string,
  run: { asked: boolean; granted: boolean },
): void {
  const csp = contentSecurityPolicy({ contentType: contentTypeOf(relPath), run: run.asked, unlocked: run.granted });
  if (csp !== null) res.setHeader("Content-Security-Policy", csp);
}

/**
 * The run variant's question: does a superadmin's global trust, or this
 * reader's own consent, stand behind running this version's script? The
 * reader's consent is `docs/{docId}/trust/{uid}`, their own record; a stranger,
 * a signed-out visitor and a page elsewhere (the session cookie is
 * `SameSite=Strict`) have none.
 *
 * Trust is for the CURRENT version only. Either scope is granted while one
 * version is current and withdrawn whenever another becomes current, so the
 * scripts somebody vouched for are the head's. An older version is one nobody
 * vouched for under this grant: an editor's, say, whose commit withdrew trust
 * at the time. Without this check, trusting the head again ran that one too.
 */
async function mayRunScript(
  gate: ReadGate,
  caller: Awaited<ReturnType<typeof resolveCaller>>,
  versionId: string,
): Promise<boolean> {
  if (versionId !== (gate.docData as { currentVersion?: unknown }).currentVersion) return false;
  if (globallyTrusted(gate.docData)) return true;
  if (!caller) return false;
  const consent = await gate.docSnap.ref.collection("trust").doc(caller.uid).get();
  return consent.exists;
}

/**
 * Stream a Storage object, mapping a missing object to 404 rather than 500.
 *
 * Every refusal is `private, no-store`, whatever the caller set for the bytes:
 * a 404 cached for five minutes at a public URL outlives the file that comes
 * to be there. A HEAD answers only what a GET would, so it asks Storage
 * whether the object exists unless its size is already known from the
 * version's list (SPEC §4), in which case it costs no Storage call at all.
 */
export async function streamObject(
  res: import("express").Response,
  objectKey: string,
  relPath: string,
  isHead: boolean,
  jsonErrors = false,
  size?: number,
): Promise<void> {
  const file = bucket().file(objectKey);
  const refuse = (status: number) => {
    res.setHeader("Cache-Control", "private, no-store");
    if (jsonErrors) res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(status).end();
  };
  if (isHead) {
    let length = size;
    if (length === undefined) {
      try {
        const [meta] = await file.getMetadata();
        length = Number(meta.size);
      } catch (err) {
        refuse((err as { code?: number }).code === 404 ? 404 : 500);
        return;
      }
    }
    res.setHeader("Content-Type", contentTypeOf(relPath));
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (Number.isSafeInteger(length)) res.setHeader("Content-Length", String(length));
    res.status(200).end();
    return;
  }
  res.setHeader("Content-Type", contentTypeOf(relPath));
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (size !== undefined) res.setHeader("Content-Length", String(size));
  const stream = file.createReadStream();
  stream.on("error", (err: NodeJS.ErrnoException & { code?: number }) => {
    if (res.headersSent) {
      res.destroy(err);
      return;
    }
    res.removeHeader("Content-Length");
    refuse(err.code === 404 ? 404 : 500);
  });
  stream.pipe(res);
}

/**
 * For video and audio, the answer is a `302` to a short-lived Storage link
 * rather than the bytes (`lib/medialink.ts`, SPEC §24). True when it
 * redirected; false when this runtime streams instead (the emulator).
 */
export async function redirectToMedia(
  res: import("express").Response,
  objectKey: string,
  relPath: string,
): Promise<boolean> {
  if (!isStreamedMedia(relPath)) return false;
  const url = await mediaLink({ objectKey, contentType: contentTypeOf(relPath), disposition: "inline" });
  if (!url) return false;
  // Set last, over whatever the bytes would have had: a cached redirect would
  // outlive the link it points to.
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Location", url);
  res.status(302).end();
  return true;
}

/** What a byte path knows once it has decided the caller may read. */
interface ReadGate {
  docSnap: admin.firestore.DocumentSnapshot;
  docData: DocAclData;
  visibility: ReturnType<typeof visibilityOf>;
  basis: ReadAccessBasis;
  /** When a folder's reach that opened it ends; null for the document's own bases. */
  until: number | null;
}

/**
 * May this caller read this document's bytes? Null for every "no", so the
 * caller answers each with the same 404 (SPEC §1.4b).
 *
 * Expiry is checked HERE, on the one path every byte takes, because it is not
 * in the security rules and cannot be. It shares the "you may not read this"
 * answer: an expired document must not become a way to confirm a slug exists.
 */
export async function readGate(
  caller: Awaited<ReturnType<typeof resolveCaller>>,
  docId: string,
  linkKey: string | null,
): Promise<ReadGate | null> {
  const docSnap = await db().collection("docs").doc(docId).get();
  if (!docSnap.exists) return null;
  const docData = docSnap.data() as DocAclData;
  if (frozenForReader(docData, caller)) return null;
  const proof = await linkProofFor(docSnap.ref, docData, caller, linkKey);
  // A READ path, so a folder's reach counts (ADR 0019).
  const access = await loadReadAccess(db(), docData, caller, proof);
  if (access === null) return null;
  return { docSnap, docData, visibility: visibilityOf(docData), basis: access.basis, until: access.until };
}

/** When a cached copy must stop being served: the document's expiry, or its folder reach's end. */
function cacheEnd(gate: ReadGate): number | null {
  return earlierEnd(expiryMs(gate.docData), gate.until);
}

/** Opened by a key in the URL — the document's own or a folder's — so never indexed. */
function keyedRead(gate: ReadGate): boolean {
  return gate.visibility === "unlisted" || gate.basis === "folder-link";
}

/**
 * Cache policy for a byte path's 200, set HERE rather than in firebase.json,
 * because gated and non-private content need different answers and a Hosting
 * header rule would force one on both. Versions are immutable, so public bytes
 * can never be stale; the real exposure is revocation latency, bounded to this
 * window and documented in docs/operations/overview.md.
 *
 * Only a read decided by the URL alone may be cached at that URL. A member's
 * or a link grant's read is decided by who is asking, and a grant's URL
 * carries no key, so caching it would hand the bytes to anyone at that URL.
 */
export function setContentCache(res: import("express").Response, gate: ReadGate, relPath?: string): void {
  if (gate.basis === "member" || gate.basis === "grant") {
    // A picture, a stylesheet or a font is held in the reader's own browser
    // for up to an hour, capped at expiry, so moving it out of the page does
    // not make every view fetch it again. Never `immutable`, since a version's
    // name is minted again after a withdrawal; never a script, an SVG or a
    // page, whose bytes trust is given for (SPEC §17).
    const cacheable = relPath !== undefined && CACHEABLE_FOR_MEMBERS.test(contentTypeOf(relPath));
    if (cacheable) {
      const at = cacheEnd(gate);
      const left = at === null ? MEMBER_ASSET_SECONDS : Math.floor((at - Date.now()) / 1000);
      res.setHeader("Cache-Control", `private, max-age=${Math.max(0, Math.min(MEMBER_ASSET_SECONDS, left))}`);
    } else {
      res.setHeader("Cache-Control", "private, no-store");
    }
  } else {
    /**
     * The window is capped at the time left before expiry.
     *
     * Revocation latency is a documented trade — a document made private again
     * can be served from cache for up to five minutes. An EXPIRY is not the
     * same thing: its moment is known in advance, so serving past it would be a
     * choice rather than a consequence. `max-age` never outlives the date —
     * nor the end of the folder reach that opened it.
     */
    const at = cacheEnd(gate);
    const left = at === null ? PUBLIC_CACHE_SECONDS : Math.floor((at - Date.now()) / 1000);
    const maxAge = Math.max(0, Math.min(PUBLIC_CACHE_SECONDS, left));
    res.setHeader("Cache-Control", `public, max-age=${maxAge}`);
  }
  if (keyedRead(gate)) {
    res.setHeader("X-Robots-Tag", "noindex");
  }
}

/**
 * A stored thumbnail is held in a member's browser for a day, not refetched on
 * every workspace visit, which is the point of storing it. Its URL names a key
 * the server minted, so the bytes at a URL never change and `immutable` is
 * honest. What the window bounds is revocation, capped at expiry like every
 * other window. A public or link read keeps the content policy, so a CDN still
 * only ever holds what the URL alone decides.
 */
function setThumbCache(res: import("express").Response, gate: ReadGate): void {
  if (gate.basis !== "member" && gate.basis !== "grant") {
    setContentCache(res, gate);
    return;
  }
  const at = expiryMs(gate.docData);
  const left = at === null ? THUMB_CACHE_SECONDS : Math.floor((at - Date.now()) / 1000);
  const maxAge = Math.max(0, Math.min(THUMB_CACHE_SECONDS, left));
  res.setHeader("Cache-Control", `private, max-age=${maxAge}, immutable`);
  if (keyedRead(gate)) {
    res.setHeader("X-Robots-Tag", "noindex");
  }
}

/**
 * GET /content/[~<key>/]:docId/:versionId/<relpath, default index.html>
 * GET /thumb/[~<key>/]:docId/:versionId/<key>/<cover|s<n>>.jpg
 *
 * The one path document bytes take to a browser — including the thumbnails
 * captured from them, which are the document's content too and so take the
 * same gate: a thumbnail of an expired document is exactly as unreadable as
 * the document (SPEC §17). Auth is resolved first, and a
 * caller who may not read gets the SAME 404 as a document that does not exist:
 * with no domain gate, distinguishable 403s would let any signed-in account walk
 * the slug space (SPEC §1.4b).
 *
 * An unlisted document additionally requires its link token, or a link grant
 * for a signed-in caller who presented it before. Without that, "unlisted"
 * would mean nothing more than "guess the slug" (SPEC §17). The token comes
 * from the path when the viewer put it there, so that a bundle's relative
 * files carry it too, else from `?k=`.
 */
export const contentProxy = onRequest(WARM, async (req, res) => {
  if (rejectMethod(req, res, ["GET", "HEAD"])) return;

  // Uncacheable until something deliberately says otherwise. See noStore().
  noStore(res);

  // A worker would outlive the page that registered it, and serve what it
  // likes without the lock (ADR 0021).
  if (isServiceWorkerFetch(req.get("service-worker"))) {
    res.status(404).end();
    return;
  }

  const caller = await resolveCaller(req);

  const isThumb = req.path.startsWith("/thumb/");
  const segments = pathSegments(req, isThumb ? "thumb" : "content");
  const parts = segments ? contentPath(segments) : null;
  if (!parts) {
    res.status(404).end();
    return;
  }
  const { docId, versionId, relPath } = parts;

  if (isThumb) {
    // Only a key and a slot name ever become an object key, and only one the
    // record names is served: an image a lost race or an older version left
    // behind has no URL that reaches it.
    if (!THUMB_REL.test(relPath)) {
      res.status(404).end();
      return;
    }
    const gate = await readGate(caller, docId, parts.k ?? strParam(req, "k"));
    const thumb = gate ? readThumb((gate.docData as { thumb?: unknown }).thumb) : null;
    if (!gate || !servableThumb(thumb, versionId, relPath)) {
      res.status(404).end();
      return;
    }
    setThumbCache(res, gate);
    await streamObject(res, thumbObjectKey(docId, versionId, relPath), relPath, req.method === "HEAD");
    return;
  }

  const gate = await readGate(caller, docId, parts.k ?? strParam(req, "k"));
  if (!gate) {
    res.status(404).end();
    return;
  }

  const versionSnap = await gate.docSnap.ref.collection("versions").doc(versionId).get();
  if (!versionSnap.exists) {
    res.status(404).end();
    return;
  }

  // The version's own object for this path, in whichever layout it was
  // stored (SPEC §4). A file the version does not list is a 404 here.
  const record = versionSnap.data() ?? {};
  const objectKey = versionObjectKey(docId, versionId, record, relPath);
  // Defence in depth: the resolved key must stay inside this document even if
  // a segment check above were ever loosened.
  if (!objectKey || !objectKey.startsWith(`docs/${docId}/`) || objectKey.includes("..")) {
    res.status(404).end();
    return;
  }

  // Video and audio: everything above decided, the bytes come from Storage.
  if (await redirectToMedia(res, objectKey, relPath)) return;

  setContentCache(res, gate, parts.run ? undefined : relPath);
  // Deliberately NO X-Frame-Options, and frame-ancestors only on the run
  // variant: the content must embed same-origin in the app's iframe, which is
  // what makes annotation possible.
  const runs = parts.run && isScriptable(contentTypeOf(relPath));
  const granted = runs ? await mayRunScript(gate, caller, versionId) : false;
  if (runs) {
    // Unlocked or not, this answer depends on who asked, so no cache may
    // keep it for the next person at this URL.
    res.setHeader("Cache-Control", "private, no-store");
  }
  setScriptLock(res, relPath, { asked: parts.run, granted });

  const size = storedFiles(docId, record).find((f) => f.rel === relPath)?.size;
  await streamObject(res, objectKey, relPath, req.method === "HEAD", false, size);
});

/**
 * POST /thumb?doc=&v=&kind=cover|slides&sizes=<n>,<n>,…&r=<revision> — store a
 * version's thumbnails. The body is the JPEGs back to back, in slot order.
 *
 * Captured in an editor's browser, because nothing here renders a document,
 * and stored so every member's workspace shows it without anyone rendering it
 * again. Editors only — the people who can already change what the document
 * says. On an expired document, its owner only: a cover is not the document,
 * and the owner is the one reader an expired document has left.
 *
 * Each kind is written once per version. The objects go in under a key minted
 * here; only the transaction decides whether that key becomes the record's,
 * and a loser removes what it wrote. It never touches `updatedAt`: a captured
 * image is not an edit, and the workspace sorts and labels by that field.
 */
export const saveThumbs = onRequest(PLAIN, async (req, res) => {
  if (rejectMethod(req, res, ["POST"])) return;
  noStore(res);
  const caller = await resolveCaller(req);
  if (!caller) {
    res.status(401).end();
    return;
  }

  const docId = strParam(req, "doc");
  const versionId = strParam(req, "v");
  if (!docId || !safeSegment(docId) || !/^v\d+$/.test(versionId)) {
    badRequest(res, "invalid or missing doc or v");
    return;
  }
  const parsed = parseThumbUpload(rawBuffer(req), strParam(req, "kind"), strParam(req, "sizes"));
  if ("error" in parsed) {
    badRequest(res, parsed.error);
    return;
  }
  const kind = strParam(req, "kind") as ThumbKind;
  const count = parsed.images.length;
  // Only this deployment's capture. An older page still open in some tab
  // would otherwise store the images the newer capture exists to replace.
  if (Number(strParam(req, "r")) !== THUMB_REVISION) {
    res.status(409).json({ error: "captured by an older version of the app" });
    return;
  }

  const docRef = db().collection("docs").doc(docId);
  const snap = await docRef.get();
  if (!snap.exists) {
    res.status(404).end();
    return;
  }
  const data = snap.data() as DocAclData & { currentVersion?: string; thumb?: unknown };
  if (!isDocEditor(data, caller.uid, caller.emailLower)) {
    res.status(refusal(data, caller, await linkProofFor(docRef, data, caller, null))).end();
    return;
  }
  // Frozen as a reader meets it: an editor cannot read an expired or trashed
  // document, so may not store its picture; its owner still reads it, and is
  // the only one who will ever be shown the cover.
  const frozen = frozenForReader(data, caller) ? frozenWrite(data, Date.now()) : null;
  if (frozen) {
    res.status(409).json(frozen);
    return;
  }
  if (data.currentVersion !== versionId) {
    res.status(409).json({ error: "not the current version" });
    return;
  }
  // Already there: say so before writing anything.
  if (!nextThumb(readThumb(data.thumb), versionId, kind, "", count, THUMB_REVISION).write) {
    res.status(200).json({ stored: false });
    return;
  }

  const key = randomBytes(8).toString("hex");
  const slots = thumbSlots(kind, count);
  await Promise.all(
    slots.map((slot, i) =>
      bucket()
        .file(thumbObjectKey(docId, versionId, `${key}/${slot}.jpg`))
        .save(parsed.images[i], { contentType: "image/jpeg", resumable: false, ...CREATE_ONLY }),
    ),
  );

  const receipt = freshReceiptId();
  const outcome = await db().runTransaction(async (tx) => {
    const fresh = await tx.get(docRef);
    // A later publication may replace this upload's current key before the
    // native SDK retries. Keep its bounded result, including original cleanup.
    const committed = readReceipt<{ stored: true; moved: false; stale: StaleThumbs[] }>(fresh, receipt);
    if (committed.found) return committed.result;
    const d = fresh.data() as (DocAclData & { currentVersion?: string; thumb?: unknown }) | undefined;
    // Uploading bytes does not reserve authority: a sharing change may have
    // removed this editor while Storage was accepting the candidate images.
    if (d && !isDocEditor(d, caller.uid, caller.emailLower)) {
      return { stored: false, moved: false, stale: [], denied: d };
    }
    if (!d || d.currentVersion !== versionId || frozenForReader(d, caller)) {
      return { stored: false, moved: true, stale: [] };
    }
    const decision = nextThumb(readThumb(d.thumb), versionId, kind, key, count, THUMB_REVISION);
    if (!decision.write) return { stored: false, moved: false, stale: [] };
    const result = { stored: true as const, moved: false as const, stale: decision.stale };
    recordReceipt(tx, docRef, fresh, receipt, result);
    tx.update(docRef, { thumb: decision.thumb });
    return result;
  });
  if (outcome.stored) await clearReceipt(docRef, receipt);

  if (!outcome.stored) {
    await bucket()
      .deleteFiles({ prefix: `${thumbPrefix(docId, versionId)}${key}/`, force: true })
      .catch(() => undefined);
    if (outcome.denied) {
      res.status(refusal(outcome.denied, caller, await linkProofFor(docRef, outcome.denied, caller, null))).end();
    } else if (outcome.moved) {
      res.status(409).json({ error: "not the current version" });
    } else {
      res.status(200).json({ stored: false });
    }
    return;
  }
  // What the record moved past — a whole older version, or an older
  // capture's keys under this one: nothing can name those images any more.
  for (const gone of outcome.stale) {
    const prefix = `${thumbPrefix(docId, gone.versionId)}${gone.key ? `${gone.key}/` : ""}`;
    await bucket().deleteFiles({ prefix, force: true }).catch(() => undefined);
  }
  res.status(200).json({ stored: true });
});

/**
 * GET /download/:docId/:versionId — the published bundle as a .zip.
 *
 * Same 403-to-404 collapse as contentProxy: this is a read-only byte path.
 */
export const downloadBundle = onRequest(PLAIN, async (req, res) => {
  if (rejectMethod(req, res, ["GET", "HEAD"])) return;
  noStore(res); // before any branch can return — see noStore()
  const caller = await resolveCaller(req);

  const segments = pathSegments(req, "download");
  if (!segments || segments.length < 2) {
    res.status(404).end();
    return;
  }
  const [docId, versionId] = segments;

  const docSnap = await db().collection("docs").doc(docId).get();
  if (!docSnap.exists) {
    res.status(404).end();
    return;
  }
  const docData = docSnap.data() as DocAclData & { slug?: string };
  if (frozenForReader(docData, caller)) {
    res.status(404).end();
    return;
  }
  const proof = await linkProofFor(docSnap.ref, docData, caller, strParam(req, "k"));
  // A read of every byte, so a folder's reach counts, as it does for content.
  if ((await loadReadAccess(db(), docData, caller, proof)) === null) {
    res.status(404).end();
    return;
  }

  const versionSnap = await docSnap.ref.collection("versions").doc(versionId).get();
  if (!versionSnap.exists) {
    res.status(404).end();
    return;
  }

  const listed = await versionFiles(docId, versionId, versionSnap.data() ?? {}, bucket() as unknown as ListingBucket);
  const files: BundleEntry[] = [];
  let total = 0;
  for (const { rel, key, size } of listed) {
    // Refused before reading when the list already says it is too big.
    if (size !== undefined && total + size > MAX_BUNDLE_BYTES) {
      res.status(409).json({ error: "bundle too large to download" });
      return;
    }
    const [bytes] = await bucket().file(key).download();
    total += bytes.length;
    if (total > MAX_BUNDLE_BYTES) {
      res.status(409).json({ error: "bundle too large to download" });
      return;
    }
    files.push({ rel, data: bytes });
  }
  if (files.length === 0) {
    res.status(404).end();
    return;
  }

  const base = typeof docData.slug === "string" && docData.slug ? docData.slug : docId;
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${base}-${versionId}.zip"`,
  );
  if (req.method === "HEAD") {
    res.status(200).end();
    return;
  }
  res.status(200).end(zipBundle(files));
});
