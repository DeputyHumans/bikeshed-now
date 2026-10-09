// SPDX-License-Identifier: Apache-2.0
// Every HTTP endpoint and the one Firestore trigger (SPEC §2).

/**
 * Region is FIXED at us-central1: Hosting rewrites only reach functions there.
 *
 * Every endpoint is AUTH-FIRST. Authentication is resolved before anything that
 * could reveal whether a document exists, and the read-only byte paths collapse
 * "you may not read this" into 404 so a signed-in stranger cannot enumerate the
 * slug space (SPEC §1.4b).
 *
 * Clients never write docs/*, versions/*, folders/*, teams/* or public/*.
 * firestore.rules denies all of it; these functions use the Admin SDK, which
 * bypasses rules, and are therefore the only sanctioned write path.
 */

import { onRequest, type Request } from "firebase-functions/v2/https";
import { onDocumentCreated, onDocumentWritten } from "firebase-functions/v2/firestore";
import * as admin from "firebase-admin";
/**
 * FieldValue and Timestamp come from the MODULAR entry point, never through
 * `admin.firestore.*`.
 *
 * The Functions emulator wraps `firebase-admin` in a proxy so calls reach the
 * local services, and that proxy does not carry the static namespace properties
 * onto the callable `firestore` function — so `admin.firestore.FieldValue` is
 * `undefined` there and every write that stamps a timestamp throws. It works in
 * a deployed function, which is exactly why it survived 127 unit tests and was
 * only found by running the emulator suite. `Timestamp` then went the same way
 * on the one line that set an expiry, found the same way; `wiring.test.js`
 * now pins the shape.
 */
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import * as cookie from "cookie";
import * as mime from "mime-types";
import { randomBytes, createHash } from "crypto";

import {
  MAX_BEAT_MS,
  MAX_BUNDLE_BYTES,
  MAX_SESSION_MS,
  PUBLIC_CACHE_SECONDS,
  REGION,
  RESEND_API_KEY,
  SESSION_COOKIE_NAME,
  SESSION_EXPIRES_MS,
  VERIFY_TTL_MS,
  bucketName,
  isEmulated,
  publicOrigin,
  signInHint,
} from "./config";
import { verifyIdToken, verifySessionCookie } from "./lib/auth";
import { isAllowedEmail, isEmailShapeValid } from "./generated/policy";
import {
  canEdit,
  canManageSharing,
  canManageTeam,
  canRead,
  canEditFolder,
  canManageFolder,
  canReadFolder,
  canSuggest,
  expiredForReader,
  expiryMs,
  isDocApprover,
  isDocEditor,
  isExpired,
  opensEditingToAnyAccount,
  readBasis,
  tokenMatches,
  visibilityOf,
  type DocAclData,
  type LinkProof,
  type FolderAclData,
  type TeamAclData,
} from "./lib/acl";
import {
  applyAccessDelta,
  grantsOf,
  invalidPrincipals,
  normalizeEmail,
  parseAccessDelta,
  parseExpiry,
  type AccessState,
  type Role,
} from "./lib/access";
import { actorFrom, isAutomated, resolveCaller, type Actor } from "./lib/actor";
import {
  CREATE_ONLY,
  compileBundle,
  publishNewDocument,
  reviseDocument,
} from "./lib/publish";
import {
  SUGGESTION_COLOR,
  changeSuggestion,
  createSuggestion,
  isDecisionOp,
  parseAnchor,
  parseNote,
} from "./lib/suggestions";
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
} from "./lib/thumbs";
import {
  extractBundle,
  zipBundle,
  type BundleEntry,
  type ExtractedBundle,
} from "./lib/bundle";
import type { Principal } from "./lib/auth";
import {
  createFolderRecord,
  BAD_DOC_ID,
  isValidDocId,
  membershipOf,
  persistDocMembership,
  recomputeSubtree,
  resolveFolderTarget,
  slugify,
  wouldCycle,
  type FolderTarget,
  type Membership,
} from "./lib/folders";
import { computeTeamMembers, findGrantsForTeam } from "./lib/teams";
import { syncPresenceAccess } from "./lib/presence";
import { forkDocument, lineageFor } from "./lib/fork";
import { linkGrantRef, linkProofFor, grantTokenOf, recordLinkGrant } from "./lib/linkgrant";
import { readerProjection, syncPublicProjection } from "./lib/publicdoc";
import { renameDocument } from "./lib/rename";
import { documentAudience, filedIn, inheritedGrants } from "./lib/audience";
import {
  addEvent,
  annotationEvents,
  commentEvents,
  encodeCursor,
  eventActor,
  headCursor,
  recordTriggered,
  saveCursor,
  versionEvents,
} from "./lib/events";
import { commitDraft, loadVersionMeta, writeDraft } from "./lib/draft";
import {
  bearerFrom,
  isTokenShaped,
  listTokens,
  mintToken,
  revokeToken,
  verifyToken,
  type TokenChannel,
} from "./lib/tokens";
import { renderMarkdown } from "./lib/markdown/render";
import { htmlToMarkdown } from "./lib/markdown/serialize";
import { resolveMarking, type Marking } from "./lib/marking";
import { HEAD_SCAN_BYTES, readHead } from "./lib/head";
import {
  collectPrefix,
  composePage,
  decideShell,
  loadShell,
  renderShell,
  warnIfOriginUnconfigured,
  type ShellDoc,
} from "./lib/shell";
import {
  badRequest,
  contentPath,
  jsonBody,
  noStore,
  pathSegments,
  rawBuffer,
  rejectMethod,
  safeRelPath,
  safeSegment,
  strParam,
} from "./lib/http";
import {
  claimCommentCooldown,
  sendCommentNotice,
  sendInvitations,
  sendVerificationCode,
  uidForEmail,
  type InviteTarget,
} from "./email/notify";

if (admin.apps.length === 0) {
  admin.initializeApp();
}

// Once, at load: the emulator with no origin answers every /d/** with 503,
// and the symptom is far from the cause.
warnIfOriginUnconfigured(process.env, isEmulated(), console.warn);

const db = () => admin.firestore();
const bucket = () => admin.storage().bucket(bucketName());
const now = () => FieldValue.serverTimestamp();

/**
 * The status for a caller refused an action on a document that exists: 404
 * unless they may read it. A 403 confirms the id, which only a reader already
 * knows; answering 403 to anyone else would make every write endpoint the
 * existence check the read paths closed (SPEC §1.4b, §17).
 */
function refusal(
  doc: DocAclData,
  caller: { uid: string; emailLower: string } | null,
  proof?: LinkProof,
): 403 | 404 {
  return canRead(doc, caller, proof) ? 403 : 404;
}

/** The message a write path gives, which has to say how to undo it. */
const EXPIRED_WRITE = "this document has expired — change or clear its expiry to edit it";

/** Functions that may send email declare the secret; the rest never load it. */
const MAILING = { region: REGION, secrets: [RESEND_API_KEY] };
const PLAIN = { region: REGION };

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/** Extract `idToken` from a JSON body, tolerant of how the runtime parsed it. */
function extractIdToken(req: Request): string | null {
  const body = jsonBody(req) as { idToken?: unknown } | null;
  const token = body?.idToken;
  return typeof token === "string" && token.length > 0 ? token : null;
}

/**
 * POST /session — mint the __session cookie. DELETE /session — clear it.
 *
 * The response carries a TYPED OUTCOME rather than a bare status code, because
 * "verify your email" and "this deployment does not accept your address" are
 * different states with different next actions. Collapsing both into 401 is how
 * a sign-in screen ends up looking broken to the one person who most needs to
 * understand what happened.
 */
export const session = onRequest(PLAIN, async (req, res) => {
  if (req.method === "DELETE") {
    res.setHeader(
      "Set-Cookie",
      cookie.serialize(SESSION_COOKIE_NAME, "", {
        httpOnly: true,
        secure: true,
        sameSite: "strict",
        path: "/",
        maxAge: 0,
      }),
    );
    res.status(204).end();
    return;
  }
  if (rejectMethod(req, res, ["POST"])) return;

  const idToken = extractIdToken(req);
  if (!idToken) {
    res.status(401).json({ status: "session_failed" });
    return;
  }

  const gate = await verifyIdToken(idToken);
  if (!gate.ok) {
    if (gate.reason === "unverified") {
      res.status(200).json({ status: "unverified" });
      return;
    }
    if (gate.reason === "not_allowed") {
      res.status(403).json({ status: "not_allowed", message: signInHint() });
      return;
    }
    res.status(401).json({ status: "session_failed" });
    return;
  }

  let sessionCookie: string;
  try {
    sessionCookie = await admin
      .auth()
      .createSessionCookie(idToken, { expiresIn: SESSION_EXPIRES_MS });
  } catch (err) {
    /**
     * LOG IT. The client still learns only "session_failed" — it must not be
     * told whether the token was bad or the deployment is misconfigured — but
     * swallowing this server-side made the two indistinguishable to the
     * OPERATOR too, which is the person who can actually fix it.
     *
     * The realistic cause is not a bad token: minting a session cookie signs a
     * JWT, so the runtime service account needs `iam.serviceAccounts.signBlob`
     * on itself (roles/iam.serviceAccountTokenCreator). A fresh project does
     * not grant that, and the symptom is every sign-in failing with no trace.
     */
    console.error("createSessionCookie failed:", (err as Error)?.message ?? err);
    res.status(401).json({ status: "session_failed" });
    return;
  }

  /**
   * The account record, keyed by uid and carrying the verified address (SPEC
   * §14, sign-up step 4). Every email that names a person finds them through
   * it — `uidForEmail` — and skips anyone without one, silently, by design for
   * an address with no account yet. Only the code-verification path and the
   * account screen used to write it, so an account whose address arrived
   * verified (Google, GitHub) had none and was never told about a comment or a
   * suggestion. Written here, at the one door every sign-in passes, merged so
   * a preference already saved survives. A failure is logged and does not
   * refuse the sign-in: the cost of losing it is a missed email, not access.
   */
  try {
    await db()
      .collection("users")
      .doc(gate.principal.uid)
      .set({ uid: gate.principal.uid, email: gate.principal.emailLower }, { merge: true });
  } catch (err) {
    console.error("could not write the account record:", (err as Error)?.message ?? err);
  }

  res.setHeader(
    "Set-Cookie",
    cookie.serialize(SESSION_COOKIE_NAME, sessionCookie, {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/",
      maxAge: Math.floor(SESSION_EXPIRES_MS / 1000),
    }),
  );
  res.status(200).json({ status: "ok" });
});

/**
 * GET /config — the only thing a signed-out client is told about policy.
 *
 * One deployment-authored sentence for the rejection screen. Never the
 * allowlist: publishing the list of domains that may sign in publishes the
 * deployment's membership policy to every anonymous visitor.
 */
export const appConfig = onRequest({ ...PLAIN, cors: true }, async (req, res) => {
  if (rejectMethod(req, res, ["GET"])) return;
  res.setHeader("Cache-Control", "public, max-age=300");
  res.status(200).json({ signInHint: signInHint() });
});

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

/** Stream a Storage object, mapping a missing object to 404 rather than 500. */
function streamObject(
  res: import("express").Response,
  objectKey: string,
  relPath: string,
  isHead: boolean,
): void {
  const file = bucket().file(objectKey);
  res.setHeader("Content-Type", mime.lookup(relPath) || "application/octet-stream");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (isHead) {
    res.status(200).end();
    return;
  }
  const stream = file.createReadStream();
  stream.on("error", (err: NodeJS.ErrnoException & { code?: number }) => {
    if (res.headersSent) {
      res.destroy(err);
      return;
    }
    res.status(err.code === 404 ? 404 : 500).end();
  });
  stream.pipe(res);
}

/** What a byte path knows once it has decided the caller may read. */
interface ReadGate {
  docSnap: admin.firestore.DocumentSnapshot;
  docData: DocAclData;
  visibility: ReturnType<typeof visibilityOf>;
  basis: NonNullable<ReturnType<typeof readBasis>>;
}

/**
 * May this caller read this document's bytes? Null for every "no", so the
 * caller answers each with the same 404 (SPEC §1.4b).
 *
 * Expiry is checked HERE, on the one path every byte takes, because it is not
 * in the security rules and cannot be. It shares the "you may not read this"
 * answer: an expired document must not become a way to confirm a slug exists.
 */
async function readGate(
  caller: Awaited<ReturnType<typeof resolveCaller>>,
  docId: string,
  linkKey: string | null,
): Promise<ReadGate | null> {
  const docSnap = await db().collection("docs").doc(docId).get();
  if (!docSnap.exists) return null;
  const docData = docSnap.data() as DocAclData;
  if (expiredForReader(docData, caller)) return null;
  const proof = await linkProofFor(docSnap.ref, docData, caller, linkKey);
  const basis = readBasis(docData, caller, proof);
  if (basis === null) return null;
  return { docSnap, docData, visibility: visibilityOf(docData), basis };
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
function setContentCache(res: import("express").Response, gate: ReadGate): void {
  if (gate.basis === "member" || gate.basis === "grant") {
    res.setHeader("Cache-Control", "private, no-store");
  } else {
    /**
     * The window is capped at the time left before expiry.
     *
     * Revocation latency is a documented trade — a document made private again
     * can be served from cache for up to five minutes. An EXPIRY is not the
     * same thing: its moment is known in advance, so serving past it would be a
     * choice rather than a consequence. `max-age` never outlives the date.
     */
    const at = expiryMs(gate.docData);
    const left = at === null ? PUBLIC_CACHE_SECONDS : Math.floor((at - Date.now()) / 1000);
    const maxAge = Math.max(0, Math.min(PUBLIC_CACHE_SECONDS, left));
    res.setHeader("Cache-Control", `public, max-age=${maxAge}`);
  }
  if (gate.visibility === "unlisted") {
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
  if (gate.visibility === "unlisted") {
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
export const contentProxy = onRequest(PLAIN, async (req, res) => {
  if (rejectMethod(req, res, ["GET", "HEAD"])) return;

  // Uncacheable until something deliberately says otherwise. See noStore().
  noStore(res);

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
    streamObject(res, thumbObjectKey(docId, versionId, relPath), relPath, req.method === "HEAD");
    return;
  }

  const prefix = `docs/${docId}/${versionId}/`;
  const objectKey = `${prefix}${relPath}`;
  // Defence in depth: the resolved key must stay under the version prefix even
  // if a segment check above were ever loosened.
  if (!objectKey.startsWith(prefix) || objectKey.includes("..")) {
    res.status(404).end();
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

  setContentCache(res, gate);
  // Deliberately NO X-Frame-Options or frame-ancestors: the content must embed
  // same-origin in the app's iframe, which is what makes annotation possible.

  streamObject(res, objectKey, relPath, req.method === "HEAD");
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
    res.status(refusal(data, caller)).end();
    return;
  }
  // Expired as a reader meets it: an editor cannot read an expired document,
  // so may not store its picture; its owner still reads it, and is the only
  // one who will ever be shown the cover.
  if (expiredForReader(data, caller)) {
    res.status(409).json({ error: EXPIRED_WRITE });
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

  const outcome = await db().runTransaction(async (tx) => {
    const fresh = await tx.get(docRef);
    const d = fresh.data() as (DocAclData & { currentVersion?: string; thumb?: unknown }) | undefined;
    if (!d || d.currentVersion !== versionId || expiredForReader(d, caller)) {
      return { stored: false, moved: true, stale: [] };
    }
    const decision = nextThumb(readThumb(d.thumb), versionId, kind, key, count, THUMB_REVISION);
    if (!decision.write) return { stored: false, moved: false, stale: [] };
    tx.update(docRef, { thumb: decision.thumb });
    return { stored: true, moved: false, stale: decision.stale };
  });

  if (!outcome.stored) {
    await bucket()
      .deleteFiles({ prefix: `${thumbPrefix(docId, versionId)}${key}/`, force: true })
      .catch(() => undefined);
    if (outcome.moved) {
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
  if (expiredForReader(docData, caller)) {
    res.status(404).end();
    return;
  }
  const proof = await linkProofFor(docSnap.ref, docData, caller, strParam(req, "k"));
  if (!canRead(docData, caller, proof)) {
    res.status(404).end();
    return;
  }

  const versionSnap = await docSnap.ref.collection("versions").doc(versionId).get();
  if (!versionSnap.exists) {
    res.status(404).end();
    return;
  }

  const prefix = `docs/${docId}/${versionId}/`;
  const [objects] = await bucket().getFiles({ prefix });
  const files: BundleEntry[] = [];
  let total = 0;
  for (const obj of objects) {
    const rel = obj.name.slice(prefix.length);
    if (rel.length === 0 || rel.endsWith("/")) continue;
    const [bytes] = await obj.download();
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

// ---------------------------------------------------------------------------
// Sharing, visibility, trust, marking
// ---------------------------------------------------------------------------

function asArray(v: unknown): string[] {
  return Array.isArray(v) ? (v as string[]) : [];
}

/**
 * Record who changed access, from where.
 *
 * ACL changes were the one action with no provenance record at all: "who
 * granted this person access, and through what" simply had no answer. Append-only
 * and editor-readable, alongside the version and view records (SPEC §17).
 */
async function logAclChange(
  ref: admin.firestore.DocumentReference,
  actor: Actor,
  before: readonly string[],
  after: readonly string[],
  state: AccessState,
): Promise<void> {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const added = after.filter((e) => !beforeSet.has(e));
  const removed = before.filter((e) => !afterSet.has(e));
  if (added.length === 0 && removed.length === 0) return;
  await ref.collection("acl").add({
    at: now(),
    actor,
    added,
    removed,
    ...state,
  });
}

/** The highest role an effective member holds, for the invitation copy. */
function roleOf(email: string, membership: Membership): Role {
  if (membership.approverMembers.includes(email)) return "approver";
  if (membership.editorMembers.includes(email)) return "editor";
  if (membership.suggesterMembers.includes(email)) return "suggester";
  return "viewer";
}

/**
 * POST /access — owner-only sharing changes.
 *
 * `add` accepts a plain email or a `team:{id}` grant. Both are stored as grants
 * and expanded server-side into the flat `members` array, so the Firestore list
 * rule and the workspace query are untouched by teams existing at all (SPEC §18).
 *
 * GET /access?docId= — the grants the document inherits from its folders, for
 * the owner's share panel. The record holds only the flattened result, and
 * the folders above it may be ones the owner cannot read (SPEC §13).
 */
export const setAccess = onRequest(MAILING, async (req, res) => {
  noStore(res); // before any branch can return — see noStore()
  if (rejectMethod(req, res, ["GET", "POST"])) return;
  const caller = await resolveCaller(req);
  if (!caller) {
    res.status(401).end();
    return;
  }
  if (req.method === "GET") {
    await sendDocInheritance(req, res, caller);
    return;
  }

  const body = jsonBody(req) as { docId?: unknown } | null;
  const docId = typeof body?.docId === "string" ? body.docId : "";
  if (!docId || !safeSegment(docId)) {
    badRequest(res, "invalid or missing docId");
    return;
  }
  const parsed = parseAccessDelta(body);
  if ("error" in parsed) {
    badRequest(res, parsed.error);
    return;
  }
  const bad = invalidPrincipals(parsed.delta);
  if (bad.length > 0) {
    badRequest(res, `not a valid recipient: ${bad.join(", ")}`);
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
    viewers?: unknown;
    editors?: unknown;
    folderId?: string | null;
    members?: unknown;
  };
  if (!canManageSharing(data, caller.emailLower)) {
    res.status(refusal(data, caller)).end();
    return;
  }

  const beforeMembers = asArray(data.members);
  const next = applyAccessDelta(grantsOf(data), String(data.ownerEmail), parsed.delta);

  // Recompute EFFECTIVE membership rather than just writing the new grants:
  // otherwise a direct-sharing change silently drops every reader who had access
  // through the parent folder. That was a real defect in the original CLI, and
  // it is structurally impossible here because there is one function that
  // computes membership and everything calls it.
  const actor = actorFrom(caller, req);
  const membership = await persistDocMembership(
    db(),
    ref,
    {
      ownerEmail: String(data.ownerEmail),
      grants: next,
      folderId: (data.folderId as string | null) ?? null,
    },
    {},
    (m) => {
      const was = new Set(beforeMembers);
      const now = new Set(m.members);
      const added = m.members.filter((e) => !was.has(e));
      const removed = beforeMembers.filter((e) => !now.has(e));
      return added.length || removed.length
        ? [{ type: "access.changed", audience: "editors", actor: eventActor(actor), data: { added, removed } }]
        : [];
    },
  );
  await logAclChange(ref, actor, beforeMembers, membership.members, next);

  // Invitations go to people who NEWLY gained access, computed from the
  // effective set. That definition covers a team grant for free, and it can
  // never fire on a re-save of the same list.
  const beforeSet = new Set(beforeMembers);
  const invitees: InviteTarget[] = membership.members
    .filter((e) => !beforeSet.has(e) && e !== caller.emailLower)
    .map((email) => ({ email, role: roleOf(email, membership) }));
  if (invitees.length > 0) {
    await sendInvitations(caller.emailLower, invitees, {
      title: typeof data.title === "string" ? data.title : docId,
      kind: "document",
      url: `${publicOrigin()}/d/${docId}`,
    });
  }

  res.status(200).json({ ...next, members: membership.members });
});

/** GET /access: owner-only, as changing it is, and refused as a read is. */
async function sendDocInheritance(
  req: Request,
  res: import("express").Response,
  caller: Principal,
): Promise<void> {
  const docId = strParam(req, "docId");
  if (!docId || !safeSegment(docId)) {
    badRequest(res, "invalid or missing docId");
    return;
  }
  const snap = await db().collection("docs").doc(docId).get();
  if (!snap.exists) {
    res.status(404).end();
    return;
  }
  const data = snap.data() as DocAclData & { folderId?: unknown };
  if (!canManageSharing(data, caller.emailLower)) {
    res.status(refusal(data, caller)).end();
    return;
  }
  const folderId = typeof data.folderId === "string" ? data.folderId : null;
  res.status(200).json({ inherited: await inheritedGrants(db(), caller, folderId) });
}

/**
 * POST /visibility — owner-only. `{ docId, visibility, publicEdit? }`.
 *
 * Changing to `unlisted` mints a link token; changing to `private` drops it and
 * deletes the public projection, which is the entire revocation path.
 */
export const setVisibility = onRequest(PLAIN, async (req, res) => {
  if (rejectMethod(req, res, ["POST"])) return;
  const caller = await resolveCaller(req);
  if (!caller) {
    res.status(401).end();
    return;
  }

  const body = jsonBody(req) as {
    docId?: unknown;
    visibility?: unknown;
    publicEdit?: unknown;
    expiresAt?: unknown;
  } | null;
  const docId = typeof body?.docId === "string" ? body.docId : "";
  if (!docId || !safeSegment(docId)) {
    badRequest(res, "invalid or missing docId");
    return;
  }
  const visibility = body?.visibility;
  if (visibility !== "private" && visibility !== "unlisted" && visibility !== "public") {
    badRequest(res, 'visibility must be "private", "unlisted" or "public"');
    return;
  }
  const expiry = parseExpiry(body?.expiresAt);
  if ("error" in expiry) {
    badRequest(res, expiry.error);
    return;
  }

  const ref = db().collection("docs").doc(docId);
  const snap = await ref.get();
  if (!snap.exists) {
    res.status(404).end();
    return;
  }
  const data = snap.data() as DocAclData & { linkToken?: string };
  if (!canManageSharing(data, caller.emailLower)) {
    res.status(refusal(data, caller)).end();
    return;
  }

  const update: Record<string, unknown> = {
    visibility,
    publicEdit: body?.publicEdit === true && visibility !== "private",
    expiresAt:
      expiry.value === null
        ? FieldValue.delete()
        : Timestamp.fromMillis(expiry.value),
    updatedAt: now(),
  };
  if (visibility === "unlisted") {
    // Reuse an existing token so an already-circulated link keeps working
    // through an unrelated setting change.
    update.linkToken =
      typeof data.linkToken === "string" && data.linkToken.length >= 22
        ? data.linkToken
        : randomBytes(16).toString("base64url");
  } else {
    update.linkToken = FieldValue.delete();
  }
  // Visibility and expiry decide who may read the document and until when, so
  // each is an event, written with the change. The link's key never is.
  const batch = db().batch();
  batch.set(ref, update, { merge: true });
  const who = eventActor(actorFrom(caller, req));
  const wasVisibility = visibilityOf(data);
  const wasPublicEdit = (data as { publicEdit?: unknown }).publicEdit === true;
  if (wasVisibility !== visibility || wasPublicEdit !== update.publicEdit) {
    addEvent(batch, ref, {
      type: "doc.visibility",
      audience: "editors",
      actor: who,
      data: { from: wasVisibility, to: visibility, publicEdit: update.publicEdit },
    });
  }
  const wasExpiry = expiryMs(data);
  if (wasExpiry !== expiry.value) {
    addEvent(batch, ref, { type: "doc.expiry", audience: "readers", actor: who, data: { from: wasExpiry, to: expiry.value } });
  }
  await batch.commit();
  await syncPublicProjection(db(), docId);
  // Open editing widens who may write the SHARED document too, and the RTDB
  // gate is a mirror rather than a query, so it has to be told. Only a PUBLIC
  // document opens it to any account: the realtime rules cannot see a link's
  // key, so an unlisted document's link holders edit through /draft instead.
  await syncPresenceAccess(
    docId,
    asArray(data.members),
    asArray(data.editorMembers),
    opensEditingToAnyAccount({ ...data, ...update } as DocAclData),
  );

  const fresh = await ref.get();
  res.status(200).json({
    visibility,
    publicEdit: fresh.data()?.publicEdit === true,
    linkToken: fresh.data()?.linkToken ?? null,
    expiresAt: expiryMs(fresh.data() as DocAclData),
  });
});


/**
 * POST /trust — the owner lifts (or restores) the untrusted-content sandbox.
 *
 * Owner-only, and gated exactly like sharing: flipping this lets the bundle's own
 * JavaScript run same-origin for EVERY reader, which is a decision made on other
 * people's behalf. The per-account opt-in is a client write to
 * docs/{docId}/trust/{uid} and never touches this flag (SPEC §6c).
 */
export const trustDoc = onRequest(PLAIN, async (req, res) => {
  if (rejectMethod(req, res, ["POST"])) return;
  const caller = await resolveCaller(req);
  if (!caller) {
    res.status(401).end();
    return;
  }

  const body = jsonBody(req) as { docId?: unknown; trusted?: unknown } | null;
  const docId = typeof body?.docId === "string" ? body.docId : "";
  if (!docId || !safeSegment(docId)) {
    badRequest(res, "invalid or missing docId");
    return;
  }
  const trusted = body?.trusted !== false;

  const ref = db().collection("docs").doc(docId);
  const snap = await ref.get();
  if (!snap.exists) {
    res.status(404).end();
    return;
  }
  const data = snap.data() as DocAclData;
  if (!canManageSharing(data, caller.emailLower)) {
    res.status(refusal(data, caller)).end();
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
    res.status(refusal(data, caller)).end();
    return;
  }

  await ref.set({ marking, updatedAt: now() }, { merge: true });
  res.status(200).json({ marking });
});

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
  // Refused for the OWNER too: an expired document is frozen, and lifting the
  // date is what unfreezes it. One action, rather than a special case here.
  if (isExpired(data, Date.now())) {
    res.status(409).json({ error: EXPIRED_WRITE });
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
  const draft = await writeDraft({
    docRef: ref,
    baseVersion,
    version,
    content:
      markdown === null ? { html } : { markdown, html: renderMarkdown(markdown, { title: data.title }).html },
    existingSessions: data.draft?.editSessions,
    emailLower: caller.emailLower,
    actor: actorFrom(caller, req),
  });

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
    draft?: { baseVersion?: string; entry?: string } | null;
  };
  const proof = await linkProofFor(docSnap.ref, docData, caller, null);
  if (!canEdit(docData, caller, proof)) {
    res.status(refusal(docData, caller, proof)).end();
    return;
  }
  if (isExpired(docData, Date.now())) {
    res.status(409).json({ error: EXPIRED_WRITE });
    return;
  }

  const baseVersion = docData.draft?.baseVersion ?? docData.currentVersion;
  if (typeof baseVersion !== "string" || !safeSegment(baseVersion)) {
    res.status(404).end();
    return;
  }

  let relPath = segments.slice(1).join("/");
  if (relPath.length === 0) {
    const version = await loadVersionMeta(docSnap.ref, baseVersion);
    const entry = docData.draft?.entry ?? version?.entry;
    if (typeof entry !== "string" || safeRelPath(entry) == null) {
      res.status(404).end();
      return;
    }
    relPath = entry;
  }

  const draftKey = `docs/${docId}/draft/${relPath}`;
  const baseKey = `docs/${docId}/${baseVersion}/${relPath}`;
  let objectKey = draftKey;
  const [draftExists] = await bucket().file(draftKey).exists();
  if (!draftExists) {
    objectKey = baseKey;
    const [baseExists] = await bucket().file(baseKey).exists();
    if (!baseExists) {
      res.status(404).end();
      return;
    }
  }

  res.setHeader("Cache-Control", "private, no-store");
  streamObject(res, objectKey, relPath, req.method === "HEAD");
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
  // Refused for the OWNER too: an expired document is frozen, and lifting the
  // date is what unfreezes it. One action, rather than a special case here.
  if (isExpired(data, Date.now())) {
    res.status(409).json({ error: EXPIRED_WRITE });
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
  if (isExpired(data, Date.now())) {
    res.status(409).json({ error: EXPIRED_WRITE });
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
  if ((op === "claim" || op === "accept") && data.currentVersion !== versionId) {
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
export const createDoc = onRequest(PLAIN, async (req, res) => {
  if (rejectMethod(req, res, ["POST"])) return;
  const caller = await resolveCaller(req);
  if (!caller) {
    res.status(401).end();
    return;
  }

  const buffer = rawBuffer(req);
  if (!buffer || buffer.length === 0) {
    badRequest(res, "no file uploaded");
    return;
  }
  const wantedId = strParam(req, "id");
  if (wantedId && !isValidDocId(wantedId)) {
    badRequest(res, BAD_DOC_ID);
    return;
  }
  const filename = strParam(req, "filename");
  const extracted = extractBundle(buffer, filename, MAX_BUNDLE_BYTES);
  if ("error" in extracted) {
    badRequest(res, extracted.error);
    return;
  }

  const updating = strParam(req, "update");
  if (updating) {
    await updateFromUpload(req, res, caller, updating, extracted);
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
    title: strParam(req, "title") || compiled.title,
    folderId: target.id,
    parentMembership: target.membership,
    marking: jsonParam(req, "marking"),
    via: "upload",
    ...(wantedId ? { docId: wantedId } : {}),
  }).catch((e: Error) => e);

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
  extracted: ExtractedBundle,
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
  if (isExpired(data, Date.now())) {
    res.status(409).json({ error: EXPIRED_WRITE });
    return;
  }

  const actor = actorFrom(caller, req);
  const result = await reviseDocument({
    db: db(),
    docRef,
    baseVersion: String(data.currentVersion ?? ""),
    title: String(data.title ?? docId),
    extracted,
    actor,
    authorEmail: caller.emailLower,
    via: isAutomated(actor) ? (actor.channel as "cli" | "mcp" | "api") : "upload",
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

/**
 * POST /folder-access — owner-only folder sharing, fanned out to the subtree.
 *
 * The cascade is the expensive part and it is deliberate: inheritance is
 * denormalized at write time so the read path stays one array-contains query
 * with a statically provable rule (SPEC §5, §13).
 *
 * GET /folder-access?folderId= — the grants the folder inherits from the
 * folders above it, for the owner's share panel, as GET /access does.
 */
export const setFolderAccess = onRequest(MAILING, async (req, res) => {
  noStore(res); // before any branch can return — see noStore()
  if (rejectMethod(req, res, ["GET", "POST"])) return;
  const caller = await resolveCaller(req);
  if (!caller) {
    res.status(401).end();
    return;
  }
  if (req.method === "GET") {
    await sendFolderInheritance(req, res, caller);
    return;
  }

  const body = jsonBody(req) as { folderId?: unknown } | null;
  const folderId = typeof body?.folderId === "string" ? body.folderId : "";
  if (!folderId || !safeSegment(folderId)) {
    badRequest(res, "invalid or missing folderId");
    return;
  }
  const parsed = parseAccessDelta(body);
  if ("error" in parsed) {
    badRequest(res, parsed.error);
    return;
  }
  const bad = invalidPrincipals(parsed.delta);
  if (bad.length > 0) {
    badRequest(res, `not a valid recipient: ${bad.join(", ")}`);
    return;
  }

  const ref = db().collection("folders").doc(folderId);
  const snap = await ref.get();
  if (!snap.exists) {
    res.status(404).end();
    return;
  }
  const data = snap.data() as FolderAclData & {
    name?: string;
    viewers?: unknown;
    editors?: unknown;
    members?: unknown;
  };
  if (!canManageFolder(data, caller.emailLower)) {
    res.status(403).end();
    return;
  }

  const beforeMembers = asArray(data.members);
  const next = applyAccessDelta(grantsOf(data), String(data.ownerEmail), parsed.delta);

  await ref.set({ ...next, updatedAt: now() }, { merge: true });
  await recomputeSubtree(db(), folderId);

  const fresh = await ref.get();
  const after = membershipOf(fresh.data());
  const beforeSet = new Set(beforeMembers);
  const invitees: InviteTarget[] = after.members
    .filter((e) => !beforeSet.has(e) && e !== caller.emailLower)
    .map((email) => ({ email, role: roleOf(email, after) }));
  if (invitees.length > 0) {
    await sendInvitations(caller.emailLower, invitees, {
      title: typeof data.name === "string" ? data.name : "a folder",
      kind: "folder",
      url: `${publicOrigin()}/folder/${folderId}`,
    });
  }

  res.status(200).json(next);
});

/** GET /folder-access: a folder inherits from its parent up, never from itself. */
async function sendFolderInheritance(
  req: Request,
  res: import("express").Response,
  caller: Principal,
): Promise<void> {
  const folderId = strParam(req, "folderId");
  if (!folderId || !safeSegment(folderId)) {
    badRequest(res, "invalid or missing folderId");
    return;
  }
  const snap = await db().collection("folders").doc(folderId).get();
  const data = snap.exists ? (snap.data() as FolderAclData & { parentId?: unknown }) : null;
  if (!data || !canManageFolder(data, caller.emailLower)) {
    // A folder the caller cannot read is not there for them.
    const reads = data !== null && canReadFolder(data, caller.uid, caller.emailLower);
    res.status(reads ? 403 : 404).end();
    return;
  }
  const parentId = typeof data.parentId === "string" ? data.parentId : null;
  res.status(200).json({ inherited: await inheritedGrants(db(), caller, parentId) });
}

/**
 * POST /organize — move, rename or delete a document or folder.
 *
 * Deleting a DOCUMENT is deliberately unsupported and says so, rather than
 * being a missing case. Deleting a folder is owner-only and reparents its
 * children to the folder's parent, so nothing is ever orphaned.
 */
export const organize = onRequest(PLAIN, async (req, res) => {
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
    body?.op === "move" || body?.op === "rename" || body?.op === "delete" ? body.op : "";
  if (!kind || !id || !safeSegment(id) || !op) {
    badRequest(res, "invalid kind/id/op");
    return;
  }

  const { uid, emailLower } = caller;

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

    if (op === "delete") {
      badRequest(res, "deleting documents is not supported");
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

    // Moving is NOT editing. Filing a document into a folder makes that folder's
    // members the document's members, so open editing — which lets any account
    // edit — would let any account move someone's document into its own folder
    // and become a member: member list, reading statistics, link token. Only
    // the real editor set may move (SPEC §19).
    if (!isDocEditor(data, uid, emailLower)) {
      res.status(403).end();
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
      {
        ownerEmail: String(data.ownerEmail || ""),
        grants: grantsOf(data),
        folderId: target.id,
      },
      { folderId: target.id },
      () =>
        fromFolder === target.id
          ? []
          : [{ type: "doc.moved", audience: "editors", actor: eventActor(actorFrom(caller, req)), data: { from: fromFolder, to: target.id } }],
    );
    res.status(200).json({ ok: true });
    return;
  }

  const ref = db().collection("folders").doc(id);
  const snap = await ref.get();
  if (!snap.exists) {
    res.status(404).end();
    return;
  }
  const data = snap.data() as FolderAclData & {
    parentId?: string | null;
    ownerEmail?: string;
  };

  if (op === "rename") {
    if (!canEditFolder(data, uid, emailLower)) {
      res.status(403).end();
      return;
    }
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 120) {
      badRequest(res, "folder name is required (up to 120 characters)");
      return;
    }
    await ref.set({ name, slug: slugify(name), updatedAt: now() }, { merge: true });
    res.status(200).json({ ok: true });
    return;
  }

  if (op === "move") {
    if (!canEditFolder(data, uid, emailLower)) {
      res.status(403).end();
      return;
    }
    const target: FolderTarget = await resolveFolderTarget(
      db(),
      body?.targetFolderId,
      caller,
    );
    if (!target.ok) {
      res.status(target.status).json({ error: target.error });
      return;
    }
    if (target.id && (await wouldCycle(db(), id, target.id))) {
      badRequest(res, "cannot move a folder into itself");
      return;
    }
    await ref.set({ parentId: target.id, updatedAt: now() }, { merge: true });
    await recomputeSubtree(db(), id);
    res.status(200).json({ ok: true });
    return;
  }

  // Delete: folder only, owner only, children reparented — never orphaned.
  if (!canManageFolder(data, emailLower)) {
    res.status(403).end();
    return;
  }
  const newParent = data.parentId ?? null;
  const childFolders = await db().collection("folders").where("parentId", "==", id).get();
  const childDocs = await db().collection("docs").where("folderId", "==", id).get();

  const rebatch = db().batch();
  for (const c of childFolders.docs) rebatch.set(c.ref, { parentId: newParent }, { merge: true });
  for (const d of childDocs.docs) rebatch.set(d.ref, { folderId: newParent }, { merge: true });
  await rebatch.commit();

  for (const c of childFolders.docs) await recomputeSubtree(db(), c.id);
  if (!childDocs.empty && newParent) {
    await recomputeSubtree(db(), newParent);
  } else {
    for (const d of childDocs.docs) {
      const dd = d.data();
      await persistDocMembership(db(), d.ref, {
        ownerEmail: String(dd.ownerEmail || ""),
        grants: grantsOf(dd),
        folderId: null,
      });
    }
  }

  await ref.delete();
  res.status(200).json({ ok: true });
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

// ---------------------------------------------------------------------------
// Reading statistics
// ---------------------------------------------------------------------------

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
  if (rejectMethod(req, res, ["POST"])) return;
  noStore(res); // before any branch can return — see noStore()
  const caller = await resolveCaller(req);

  const body = jsonBody(req) as {
    docId?: unknown;
    versionId?: unknown;
    sessionId?: unknown;
    ms?: unknown;
    k?: unknown;
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
  const basis = readBasis(docData, caller, proof);
  if (basis === null || expiredForReader(docData, caller)) {
    res.status(404).end();
    return;
  }

  const actor = caller ? actorFrom(caller, req) : null;
  const automated = actor ? isAutomated(actor) : false;
  const via: "app" | "unlisted" | "public" =
    basis === "member" ? "app" : basis === "public" ? "public" : "unlisted";

  const rawMs = typeof body?.ms === "number" && Number.isFinite(body.ms) ? body.ms : 0;
  const claimedMs = automated
    ? 0
    : Math.min(Math.max(0, Math.floor(rawMs)), MAX_SESSION_MS);

  const sessionRef = docRef.collection("views").doc(sessionId);
  const viewerRef = caller ? docRef.collection("viewers").doc(caller.uid) : null;

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
    const delta = Math.min(Math.max(0, claimedMs - storedMs), MAX_BEAT_MS);
    const sessionMs = storedMs + delta;

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
          lastViewedAt: now(),
        },
        { merge: true },
      );
    }

    tx.set(
      docRef,
      {
        stats: automated
          ? { apiReads: FieldValue.increment(isNewSession ? 1 : 0) }
          : {
              views: FieldValue.increment(isNewSession ? 1 : 0),
              viewers: FieldValue.increment(isNewViewer ? 1 : 0),
              totalMs: FieldValue.increment(delta),
              lastViewedAt: now(),
              ...(caller ? { lastViewedByEmail: caller.emailLower } : {}),
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
 */
export const unlockDoc = onRequest(PLAIN, async (req, res) => {
  if (rejectMethod(req, res, ["POST"])) return;
  noStore(res); // every answer, the 200 included: it may have minted a grant
  const caller = await resolveCaller(req);

  const body = jsonBody(req) as { docId?: unknown; k?: unknown } | null;
  const docId = typeof body?.docId === "string" ? body.docId : "";
  if (!docId || !safeSegment(docId)) {
    badRequest(res, "invalid or missing docId");
    return;
  }
  const k = typeof body?.k === "string" ? body.k.trim() : null;

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
  const basis = readBasis(data, caller, { k, grantToken: grantTokenOf(grantSnap) });
  const projection = basis === null ? null : await readerProjection(docRef, data);
  if (!projection) {
    res.status(404).end();
    return;
  }

  if (
    basis === "link" &&
    caller &&
    typeof data.linkToken === "string" &&
    !tokenMatches(data.linkToken, grantTokenOf(grantSnap))
  ) {
    await recordLinkGrant(docRef, caller.uid, data.linkToken);
  }
  res.status(200).json(projection);
});

// ---------------------------------------------------------------------------
// Email verification
// ---------------------------------------------------------------------------

const VERIFY_MAX_ATTEMPTS = 5;
const VERIFY_RESEND_GAP_MS = 60 * 1000;

function sixDigitCode(): string {
  // randomInt-free so the dependency surface stays at crypto primitives we
  // already use; modulo bias over 10^6 from 4 bytes is ~1e-13 and irrelevant
  // for a single-use, 15-minute, rate-limited code.
  return String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

/**
 * POST /verify/start and POST /verify/complete.
 *
 * The flow exists because GitHub does not assert `email_verified`, and the ACL
 * is keyed by email: signing in with an unverified address that matches a
 * pending share would hand an attacker someone else's documents.
 *
 * Completing it calls `updateUser({ emailVerified: true })`, writing FIREBASE's
 * canonical field. That is the whole trick — one gate, one source of truth, and
 * not a single change to firestore.rules to support a second provider.
 */
export const verifyEmail = onRequest(MAILING, async (req, res) => {
  if (rejectMethod(req, res, ["POST"])) return;

  const authHeader = req.headers.authorization;
  const idToken =
    typeof authHeader === "string" && /^Bearer /i.test(authHeader)
      ? authHeader.slice(7)
      : "";
  let decoded: admin.auth.DecodedIdToken;
  try {
    decoded = await admin.auth().verifyIdToken(idToken, true);
  } catch {
    res.status(401).end();
    return;
  }

  const uid = decoded.uid;
  const action = req.path.endsWith("/complete") ? "complete" : "start";
  const ref = db().collection("users").doc(uid);

  if (action === "start") {
    const body = jsonBody(req) as { email?: unknown } | null;
    const email = normalizeEmail(
      typeof body?.email === "string" ? body.email : (decoded.email ?? ""),
    );
    // Two distinct failures, so the UI can explain which one happened: a
    // malformed address and a well-formed one this deployment does not accept
    // are different problems with different next steps.
    if (!isEmailShapeValid(email)) {
      badRequest(res, "invalid email address");
      return;
    }
    if (!isAllowedEmail(email)) {
      res.status(403).json({ error: "email not permitted by policy" });
      return;
    }

    const existing = (await ref.get()).data()?.verification as
      | { sentAt?: number }
      | undefined;
    if (existing?.sentAt && Date.now() - existing.sentAt < VERIFY_RESEND_GAP_MS) {
      res.status(429).json({ error: "a code was just sent; wait a minute" });
      return;
    }

    const code = sixDigitCode();
    await ref.set(
      {
        verification: {
          // Only a hash is stored: a leaked user record must not contain a
          // working credential, even one that lives fifteen minutes.
          hash: createHash("sha256").update(`${uid}:${code}`).digest("hex"),
          email,
          expiresAt: Date.now() + VERIFY_TTL_MS,
          attempts: 0,
          sentAt: Date.now(),
        },
      },
      { merge: true },
    );
    await sendVerificationCode(email, code, Math.round(VERIFY_TTL_MS / 60000));
    res.status(200).json({ sent: true, email });
    return;
  }

  const body = jsonBody(req) as { code?: unknown } | null;
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  const snap = await ref.get();
  const verification = snap.data()?.verification as
    | { hash?: string; email?: string; expiresAt?: number; attempts?: number }
    | undefined;
  if (!verification?.hash || !verification.email) {
    res.status(409).json({ error: "no verification in progress" });
    return;
  }
  if (Number(verification.expiresAt ?? 0) < Date.now()) {
    await ref.set({ verification: FieldValue.delete() }, { merge: true });
    res.status(409).json({ error: "that code has expired" });
    return;
  }
  if (Number(verification.attempts ?? 0) >= VERIFY_MAX_ATTEMPTS) {
    await ref.set({ verification: FieldValue.delete() }, { merge: true });
    res.status(429).json({ error: "too many attempts; request a new code" });
    return;
  }

  const expected = createHash("sha256").update(`${uid}:${code}`).digest("hex");
  if (expected !== verification.hash) {
    await ref.set(
      { verification: { attempts: Number(verification.attempts ?? 0) + 1 } },
      { merge: true },
    );
    res.status(400).json({ error: "that code is not right" });
    return;
  }

  await admin.auth().updateUser(uid, {
    email: verification.email,
    emailVerified: true,
  });
  await ref.set(
    {
      uid,
      email: verification.email,
      verification: FieldValue.delete(),
    },
    { merge: true },
  );
  res.status(200).json({ verified: true, email: verification.email });
});

// ---------------------------------------------------------------------------
// Personal access tokens
// ---------------------------------------------------------------------------

/**
 * POST /tokens — `{ op: "create" | "revoke" | "list", ... }`.
 *
 * A token carries exactly its owner's identity and therefore exactly their ACL.
 * No service accounts, no impersonation, no second permission model to reason
 * about: a token can do what its owner can do and nothing more.
 */
export const manageTokens = onRequest(PLAIN, async (req, res) => {
  if (rejectMethod(req, res, ["POST"])) return;
  const body = jsonBody(req) as {
    op?: unknown;
    name?: unknown;
    channel?: unknown;
    tokenId?: unknown;
  } | null;
  const op = body?.op;

  // Session-only, with one exception. Minting a credential with a credential is
  // how a leaked token becomes permanent access, and listing would show a
  // stolen token every other one. Revoking ITSELF can only shrink access: a
  // leaked token used that way ends itself and nothing else. It is how
  // `bikeshed logout` signs a computer out on the server too (SPEC §23).
  const cookieHeader = cookie.parse(req.headers.cookie || "")[SESSION_COOKIE_NAME];
  const caller = cookieHeader ? await verifySessionCookie(cookieHeader) : null;
  if (!caller) {
    const bearer = bearerFrom(req.headers.authorization);
    const presented =
      op === "revoke" && isTokenShaped(bearer) ? await verifyToken(db(), bearer as string) : null;
    if (!presented) {
      res.status(401).end();
      return;
    }
    if (body?.tokenId !== undefined && body.tokenId !== presented.tokenId) {
      res.status(403).json({ error: "A token can revoke only itself." });
      return;
    }
    const ok = await revokeToken(db(), presented.uid, presented.tokenId);
    res.status(ok ? 200 : 404).json({ revoked: ok });
    return;
  }

  if (op === "list") {
    res.status(200).json({ tokens: await listTokens(db(), caller.uid) });
    return;
  }

  if (op === "create") {
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name) {
      badRequest(res, "name is required — an unnamed token cannot be revoked with confidence");
      return;
    }
    const channel: TokenChannel =
      body?.channel === "cli" || body?.channel === "mcp" ? body.channel : "api";
    const minted = await mintToken(db(), caller.uid, caller.emailLower, name, channel);
    // Shown once. There is no second chance by design.
    res.status(200).json({ tokenId: minted.tokenId, token: minted.plaintext });
    return;
  }

  if (op === "revoke") {
    const tokenId = typeof body?.tokenId === "string" ? body.tokenId : "";
    if (!tokenId) {
      badRequest(res, "tokenId is required");
      return;
    }
    const ok = await revokeToken(db(), caller.uid, tokenId);
    res.status(ok ? 200 : 404).json({ revoked: ok });
    return;
  }

  badRequest(res, 'op must be "create", "revoke" or "list"');
});

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

/**
 * Re-expand every grant that names this team.
 *
 * The affected set is an `array-contains` QUERY over `team:{id}` grants, not a
 * traversal, which is what lets this reuse the folder cascade rather than needing
 * a job queue. The cost is honest: a team granted on 200 documents is 200 writes.
 * That is a batch, and the trade is written down in docs/architecture/overview.md rather
 * than discovered at ten thousand documents.
 */
async function refanTeam(teamId: string): Promise<number> {
  const { docIds, folderIds } = await findGrantsForTeam(db(), teamId);
  for (const id of docIds) {
    const ref = db().collection("docs").doc(id);
    const snap = await ref.get();
    if (!snap.exists) continue;
    const d = snap.data() || {};
    await persistDocMembership(db(), ref, {
      ownerEmail: String(d.ownerEmail || ""),
      grants: grantsOf(d),
      folderId: (d.folderId as string | null) ?? null,
    });
  }
  for (const id of folderIds) {
    await recomputeSubtree(db(), id);
  }
  return docIds.length + folderIds.length;
}

/** POST /team — `{ op: "create" | "rename" | "delete", teamId?, name? }`. */
export const manageTeam = onRequest(PLAIN, async (req, res) => {
  if (rejectMethod(req, res, ["POST"])) return;
  const caller = await resolveCaller(req);
  if (!caller) {
    res.status(401).end();
    return;
  }

  const body = jsonBody(req) as {
    op?: unknown;
    teamId?: unknown;
    name?: unknown;
  } | null;
  const op = body?.op;

  if (op === "create") {
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 120) {
      badRequest(res, "team name is required (up to 120 characters)");
      return;
    }
    const ref = db().collection("teams").doc();
    await ref.set({
      teamId: ref.id,
      name,
      slug: slugify(name),
      ownerEmail: caller.emailLower,
      admins: [caller.emailLower],
      members: [caller.emailLower],
      createdAt: now(),
      updatedAt: now(),
    });
    res.status(200).json({ teamId: ref.id, name });
    return;
  }

  const teamId = typeof body?.teamId === "string" ? body.teamId : "";
  if (!teamId || !safeSegment(teamId)) {
    badRequest(res, "invalid or missing teamId");
    return;
  }
  const ref = db().collection("teams").doc(teamId);
  const snap = await ref.get();
  if (!snap.exists) {
    res.status(404).end();
    return;
  }
  if (!canManageTeam(snap.data() as TeamAclData, caller.emailLower)) {
    res.status(403).end();
    return;
  }

  if (op === "rename") {
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 120) {
      badRequest(res, "team name is required (up to 120 characters)");
      return;
    }
    await ref.set({ name, slug: slugify(name), updatedAt: now() }, { merge: true });
    res.status(200).json({ ok: true });
    return;
  }

  if (op === "delete") {
    await ref.delete();
    // Grants naming the team survive as dangling references and expand to
    // nothing, which DENIES. Re-fanning here is what turns that from a latent
    // inconsistency into an immediate, correct revocation.
    const affected = await refanTeam(teamId);
    res.status(200).json({ ok: true, affected });
    return;
  }

  badRequest(res, 'op must be "create", "rename" or "delete"');
});

/** POST /team-members — `{ teamId, add?: string[], remove?: string[], admin?: {...} }`. */
export const manageTeamMembers = onRequest(MAILING, async (req, res) => {
  if (rejectMethod(req, res, ["POST"])) return;
  const caller = await resolveCaller(req);
  if (!caller) {
    res.status(401).end();
    return;
  }

  const body = jsonBody(req) as {
    teamId?: unknown;
    add?: unknown;
    remove?: unknown;
    admin?: unknown;
  } | null;
  const teamId = typeof body?.teamId === "string" ? body.teamId : "";
  if (!teamId || !safeSegment(teamId)) {
    badRequest(res, "invalid or missing teamId");
    return;
  }

  const add = Array.isArray(body?.add) ? (body.add as unknown[]).map(String) : [];
  const remove = Array.isArray(body?.remove)
    ? (body.remove as unknown[]).map(String)
    : [];
  const badEmails = add.map(normalizeEmail).filter((e) => !isAllowedEmail(e));
  if (badEmails.length > 0) {
    badRequest(res, `not a valid recipient: ${badEmails.join(", ")}`);
    return;
  }

  const ref = db().collection("teams").doc(teamId);
  const snap = await ref.get();
  if (!snap.exists) {
    res.status(404).end();
    return;
  }
  const team = snap.data() as TeamAclData & { name?: string; members?: unknown };
  if (!canManageTeam(team, caller.emailLower)) {
    res.status(403).end();
    return;
  }

  const before = asArray(team.members);
  const set = new Set(before);
  for (const e of remove.map(normalizeEmail)) {
    // The owner is never removed: a team with no owner has no one who can fix it.
    if (e && e !== String(team.ownerEmail || "").toLowerCase()) set.delete(e);
  }
  for (const e of add.map(normalizeEmail)) if (e) set.add(e);
  const members = computeTeamMembers(String(team.ownerEmail || ""), [...set]);

  let admins = asArray(team.admins);
  if (body?.admin && typeof body.admin === "object") {
    const a = body.admin as { email?: unknown; isAdmin?: unknown };
    const email = normalizeEmail(typeof a.email === "string" ? a.email : "");
    if (email && members.includes(email)) {
      const adminSet = new Set(admins);
      if (a.isAdmin === true) adminSet.add(email);
      else if (email !== String(team.ownerEmail || "").toLowerCase()) adminSet.delete(email);
      admins = [...adminSet].sort();
    }
  }

  await ref.set({ members, admins, updatedAt: now() }, { merge: true });

  // Removing someone from a team must revoke their access everywhere the team
  // was granted, and adding someone must grant it. Both are the same recompute.
  const affected = await refanTeam(teamId);

  const beforeSet = new Set(before);
  const invitees: InviteTarget[] = members
    .filter((e) => !beforeSet.has(e) && e !== caller.emailLower)
    .map((email) => ({ email, role: "viewer" as const }));
  if (invitees.length > 0) {
    // A branch of the invitation template, not a fourth message type: being
    // added to a team silently grants access to everything that team holds,
    // which is the same silence the invitation exists to break.
    await sendInvitations(caller.emailLower, invitees, {
      title: typeof team.name === "string" ? team.name : "a team",
      kind: "team",
      url: `${publicOrigin()}/account`,
    });
  }

  res.status(200).json({ members, admins, affected });
});

// ---------------------------------------------------------------------------
// Public discovery
// ---------------------------------------------------------------------------

/**
 * GET /sitemap.xml — public documents only.
 *
 * Unlisted documents are deliberately absent: they carry `X-Robots-Tag: noindex`
 * and exist to be shared by link, so listing them here would defeat the entire
 * distinction between the two levels.
 */
export const sitemap = onRequest(PLAIN, async (req, res) => {
  if (rejectMethod(req, res, ["GET"])) return;
  const origin = publicOrigin();
  const snap = await db()
    .collection("public")
    .where("visibility", "==", "public")
    .orderBy("publishedAt", "desc")
    .limit(5000)
    .get();

  const entries = snap.docs
    // An expired document is not served, so listing it would be advertising a
    // 404 to a crawler. The projection carries the date precisely so this can
    // be decided without a second read per row.
    .filter((d) => !isExpired(d.data() as DocAclData, Date.now()))
    .map((d) => {
      const at = d.data()?.publishedAt as admin.firestore.Timestamp | undefined;
      const lastmod = at?.toDate ? at.toDate().toISOString().slice(0, 10) : "";
      const loc = `${origin}/d/${d.id}`
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;");
      return `  <url><loc>${loc}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`;
    })
    .join("\n");

  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("Cache-Control", `public, max-age=${PUBLIC_CACHE_SECONDS}`);
  res.status(200).send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`,
  );
});

/**
 * GET /d/:docId[/:versionId] — the app shell for a document page, with the
 * document's own head for crawlers (SPEC §17).
 *
 * Hosting would answer with the static shell, whose head says "Bikeshed" and
 * nothing about the document; crawlers run no JS, so a pasted link unfurled
 * as the product. This serves the same shell to everyone and, only when
 * `decideShell` says the document is readable without an account, with its
 * title, description, keywords and Open Graph tags spliced in.
 *
 * It never authenticates. The response may be cached at a public URL, so
 * whatever it carries is what a stranger may see; a member's tab title comes
 * from the client. Two invariants, each pinned by a structural test:
 * `noStore` is the first thing to touch headers, so no early exit inherits
 * Hosting's max-age=600; and `public, max-age` is set only once the page is
 * built, so a throw before then falls back to a generic shell that is still
 * uncacheable — never a broken page pinned at a public URL for the window.
 */
export const docShell = onRequest(PLAIN, async (req, res) => {
  if (rejectMethod(req, res, ["GET", "HEAD"])) return;

  // Uncacheable until the page is built and says otherwise. See noStore().
  noStore(res);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");

  const template = await loadShell({ origin: publicOrigin() }).catch((err: unknown) => {
    // A 503 with nothing beside it is undiagnosable. The reason is
    // `loadShell`'s own wording — a status and a content type, or the fetch
    // error's class and code — never a URL or k: the fetch is to the
    // configured origin's `/`.
    console.warn("docShell: no shell to serve:", (err as { reason?: unknown })?.reason ?? (err as Error)?.name);
    return null;
  });
  if (template === null) {
    res.status(503).end();
    return;
  }

  const isHead = req.method === "HEAD";
  /** The shell as Hosting would serve it: the three headers above, no more. */
  const serveGeneric = (): void => {
    res.status(200);
    if (isHead) res.end();
    else res.send(template);
  };

  const segments = pathSegments(req, "d");
  if (!segments || segments.length < 1 || segments.length > 2) {
    serveGeneric();
    return;
  }
  const [docId] = segments;
  const pinned = segments.length === 2 ? segments[1] : null;
  const k = strParam(req, "k");

  const docSnap = await db().collection("docs").doc(docId).get();
  const doc = docSnap.exists ? (docSnap.data() as ShellDoc) : null;
  const decision = decideShell({ doc, k, versionId: pinned, now: Date.now() });
  if (decision.kind === "generic") {
    serveGeneric();
    return;
  }

  // Which step the catch is reporting on. A code or name alone cannot tell
  // this repo's own throws apart — a template missing its `</head>` and a
  // scanner bug are both a plain `Error` — and the message may name the
  // object path, so the step is logged instead.
  let stage = "version";
  try {
    const versionSnap = await docSnap.ref.collection("versions").doc(decision.versionId).get();
    if (!versionSnap.exists) {
      serveGeneric();
      return;
    }
    const data = versionSnap.data() || {};
    const entry = safeRelPath(String(data.entry ?? "index.html"));
    if (entry === null) {
      serveGeneric();
      return;
    }
    const files: string[] = Array.isArray(data.files)
      ? data.files.filter((f: unknown): f is string => typeof f === "string")
      : [];

    // Only the prefix the scanner reads; `collectPrefix` enforces the cap
    // even where the range is ignored.
    stage = "stream";
    const stream = bucket()
      .file(`docs/${docId}/${decision.versionId}/${entry}`)
      .createReadStream({ start: 0, end: HEAD_SCAN_BYTES - 1 });
    const bytes = await collectPrefix(stream, HEAD_SCAN_BYTES);
    stage = "scan";
    const head = readHead(bytes.toString("utf8"));

    stage = "render";
    const page = composePage({
      origin: publicOrigin(),
      docId,
      requestedVersion: pinned,
      decision,
      docTitle: typeof doc?.title === "string" ? doc.title : "Untitled",
      head,
      entry,
      files,
      k,
    });
    const html = renderShell(template, page);

    // ONLY NOW: the page exists, so this URL may be cached with it.
    res.setHeader("Cache-Control", `public, max-age=${decision.maxAge}`);
    if (decision.noindex) res.setHeader("X-Robots-Tag", "noindex");
    res.status(200);
    if (isHead) res.end();
    else res.send(html);
  } catch (err) {
    // The generic shell is a 200, so without this line a runtime identity
    // that cannot read the bucket would serve the product's head for every
    // document and the request log would show nothing. The step and a code
    // or name only: a GCS message names the object path, which holds the
    // document id.
    console.warn("docShell: generic fallback at", stage, (err as { code?: unknown })?.code ?? (err as Error)?.name);
    // A throw between the public header and the send lands here with that
    // header — and, for an unlisted document, X-Robots-Tag — already set.
    // The generic shell carries neither.
    noStore(res);
    res.removeHeader("X-Robots-Tag");
    serveGeneric();
  }
});

// ---------------------------------------------------------------------------
// Comment notifications — the only non-HTTP function in the codebase
// ---------------------------------------------------------------------------

/**
 * Tell the people in a thread that somebody replied.
 *
 * Bounded BY CONSTRUCTION rather than by infrastructure: one trigger, a
 * recipient set of owner plus prior participants minus the author, and a
 * per-(recipient, document) cooldown stored on the user record. No queue, no
 * scheduler, no cron — because the moment this needs any of those, it has become
 * a notification system, and this product does not have one.
 */
export const onCommentCreated = onDocumentCreated(
  {
    document:
      "docs/{docId}/versions/{versionId}/annotations/{annId}/comments/{commentId}",
    region: REGION,
    secrets: [RESEND_API_KEY],
  },
  async (event) => {
    const comment = event.data?.data();
    if (!comment) return;
    const { docId, versionId, annId } = event.params;

    const authorEmail = normalizeEmail(String(comment.authorEmail || ""));
    const actor = comment.actor as Actor | undefined;

    const docRef = db().collection("docs").doc(docId);
    const [docSnap, annSnap, siblingSnap] = await Promise.all([
      docRef.get(),
      docRef
        .collection("versions")
        .doc(versionId)
        .collection("annotations")
        .doc(annId)
        .get(),
      docRef
        .collection("versions")
        .doc(versionId)
        .collection("annotations")
        .doc(annId)
        .collection("comments")
        .get(),
    ]);
    if (!docSnap.exists) return;
    const doc = docSnap.data() || {};

    const recipients = new Set<string>();
    const owner = normalizeEmail(String(doc.ownerEmail || ""));
    if (owner) recipients.add(owner);
    // A new suggestion is for the people who can decide it: only they can
    // clear it, and until they do it holds back the next version (SPEC §22).
    const suggestion = comment.opensSuggestion === true ? annSnap.data()?.suggestion : null;
    const deciders = suggestion ? membershipOf(doc).approverMembers : [];
    for (const e of deciders) recipients.add(normalizeEmail(e));
    for (const c of siblingSnap.docs) {
      const e = normalizeEmail(String(c.data()?.authorEmail || ""));
      if (e) recipients.add(e);
    }
    recipients.delete(authorEmail);
    if (recipients.size === 0) return;

    const quote = String(annSnap.data()?.anchor?.exact ?? "").slice(0, 300);
    // A generated opener restates the change, which the notice shows as the
    // change itself; only a note the author wrote is worth repeating.
    const body =
      suggestion && comment.generated === true ? "" : String(comment.body ?? "").slice(0, 2000);
    const title = typeof doc.title === "string" ? doc.title : docId;
    const viaChannel =
      actor && actor.channel !== "web"
        ? (actor.channel as "cli" | "mcp" | "api")
        : undefined;

    for (const email of recipients) {
      const uid = await uidForEmail(db(), email);
      // No account yet means no cooldown record and no preference to honour.
      // Staying silent is the right default: they were never told about the
      // document either.
      if (!uid) continue;
      if (!(await claimCommentCooldown(db(), uid, docId, suggestion ? "suggestion" : "comment"))) continue;
      await sendCommentNotice(email, {
        authorEmail,
        docTitle: title,
        quote,
        body,
        viaChannel,
        docId,
        versionId,
        ...(suggestion
          ? { suggestion: { replacement: String(suggestion.replacement ?? "").slice(0, 300) } }
          : {}),
      });
    }
  },
);

// ---------------------------------------------------------------------------
// The change log (SPEC §4, §19, ADR 0016)
// ---------------------------------------------------------------------------

/**
 * Three triggers record the changes that many paths make: a version (every
 * publisher, the in-app commit, the operator's withdrawal), a thread (the
 * browser directly, and the server), and a comment. A trigger on the
 * collection catches every writer, including ones added later.
 *
 * `retry: true`, which `onCommentCreated` does not have: a thrown error there
 * loses an email, which it would rather do than send one twice, but a lost
 * event here is the one failure the log cannot report. Retrying is safe
 * because recording is idempotent: each event is created under the
 * CloudEvent's id, so a redelivery finds it and writes nothing.
 */
export const recordVersionEvent = onDocumentWritten(
  { document: "docs/{docId}/versions/{versionId}", region: REGION, retry: true },
  async (event) => {
    const { docId, versionId } = event.params;
    await recordTriggered(
      db(),
      docId,
      event.id,
      versionEvents(versionId, event.data?.before?.data(), event.data?.after?.data()),
    );
  },
);

export const recordThreadEvent = onDocumentWritten(
  { document: "docs/{docId}/versions/{versionId}/annotations/{annId}", region: REGION, retry: true },
  async (event) => {
    const { docId, versionId, annId } = event.params;
    await recordTriggered(
      db(),
      docId,
      event.id,
      annotationEvents(versionId, annId, event.data?.before?.data(), event.data?.after?.data()),
    );
  },
);

export const recordCommentEvent = onDocumentCreated(
  {
    document: "docs/{docId}/versions/{versionId}/annotations/{annId}/comments/{commentId}",
    region: REGION,
    retry: true,
  },
  async (event) => {
    const { docId, versionId, annId, commentId } = event.params;
    await recordTriggered(db(), docId, event.id, commentEvents(versionId, annId, commentId, event.data?.data()));
  },
);

// ---------------------------------------------------------------------------
// Agent surface
// ---------------------------------------------------------------------------

/**
 * POST /mcp — the Model Context Protocol endpoint (SPEC §19).
 *
 * `cors: true` because a browser-hosted MCP client is a real deployment shape;
 * the credential is a Bearer token, never the session cookie, so there is no
 * cross-site request forgery surface to widen by allowing it.
 */
export const mcp = onRequest({ ...PLAIN, cors: true }, async (req, res) => {
  // Before anything can answer: a GET's 405 and every 401 would otherwise
  // inherit Hosting's default max-age=600.
  noStore(res);
  const { handleMcp } = await import("./mcp/server");
  await handleMcp(req, res);
});

/**
 * Discovery, registration and the token endpoint for apps that connect by
 * signing in (SPEC §23).
 *
 * `cors: true` for the same reason as /mcp: none of it reads a cookie, and a
 * browser-hosted client is a real deployment shape.
 */
export const oauth = onRequest({ ...PLAIN, cors: true }, async (req, res) => {
  noStore(res);
  const { handleOauth } = await import("./oauth/routes");
  await handleOauth(req, res);
});

/**
 * POST /oauth/consent — the person's decision about an app (SPEC §23).
 *
 * No CORS, deliberately: only the consent page on this origin may ask, and it
 * authenticates with the signed-in account's ID token rather than the cookie.
 */
export const oauthConsent = onRequest(PLAIN, async (req, res) => {
  noStore(res);
  const { handleConsent } = await import("./oauth/consent");
  await handleConsent(req, res);
});
