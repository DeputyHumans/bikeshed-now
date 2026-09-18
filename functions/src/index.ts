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
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import * as admin from "firebase-admin";
/**
 * FieldValue comes from the MODULAR entry point, not `FieldValue`.
 *
 * The Functions emulator wraps `firebase-admin` in a proxy so calls reach the
 * local services, and that proxy does not carry the static namespace properties
 * onto the callable `firestore` function — so `FieldValue` is
 * `undefined` there and every write that stamps a timestamp throws. It works in
 * a deployed function, which is exactly why it survived 127 unit tests and was
 * only found by running the emulator suite.
 */
import { FieldValue } from "firebase-admin/firestore";
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
  expiryMs,
  isExpired,
  isMember,
  visibilityOf,
  type DocAclData,
  type FolderAclData,
  type TeamAclData,
} from "./lib/acl";
import {
  applyAccessDelta,
  invalidPrincipals,
  normalizeEmail,
  parseAccessDelta,
  parseExpiry,
  type AccessState,
  type Role,
} from "./lib/access";
import { actorFrom, isAutomated, resolveCaller, type Actor } from "./lib/actor";
import { hashBundleFiles, type BundleFile } from "./lib/hash";
import { compileBundle, publishNewDocument } from "./lib/publish";
import { extractBundle, zipBundle, type BundleEntry } from "./lib/bundle";
import {
  computeDocMembership,
  createFolderRecord,
  persistDocMembership,
  recomputeSubtree,
  resolveFolderTarget,
  slugify,
  uniqueDocId,
  wouldCycle,
  type FolderTarget,
  type Membership,
} from "./lib/folders";
import { computeTeamMembers, findGrantsForTeam } from "./lib/teams";
import { syncPresenceAccess } from "./lib/presence";
import { syncPublicProjection } from "./lib/publicdoc";
import { listTokens, mintToken, revokeToken, type TokenChannel } from "./lib/tokens";
import { renderMarkdown } from "./lib/markdown/render";
import { htmlToMarkdown } from "./lib/markdown/serialize";
import { resolveMarking, type Marking } from "./lib/marking";
import {
  badRequest,
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

const db = () => admin.firestore();
const bucket = () => admin.storage().bucket(bucketName());
const now = () => FieldValue.serverTimestamp();

/**
 * An expired document is READ-ONLY, and visible only to its owner.
 *
 * One sentence, enforced in eight places, because expiry is not in the security
 * rules and cannot be (see `isExpired`). The owner keeps reading it because they
 * are the one who set the date and the one who can move it; locking them out of
 * their own document would make the setting unrecoverable rather than
 * reversible. Everybody else gets the same 404 a document they may not read
 * gives them, so expiry does not become a way to confirm that a slug exists.
 *
 * Writing is refused for EVERYONE, the owner included. An expired document is
 * frozen; lifting the date is what unfreezes it, and that is one action rather
 * than a special case in every write path.
 */
function expiredForReader(
  doc: DocAclData,
  caller: { uid: string; emailLower: string } | null,
): boolean {
  if (!isExpired(doc, Date.now())) return false;
  return !(caller && canManageSharing(doc, caller.emailLower));
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

/**
 * GET /content/:docId/:versionId/<relpath, default index.html>
 *
 * The one path document bytes take to a browser. Auth is resolved first, and a
 * caller who may not read gets the SAME 404 as a document that does not exist:
 * with no domain gate, distinguishable 403s would let any signed-in account walk
 * the slug space (SPEC §1.4b).
 *
 * An unlisted document additionally requires its link token. Without that,
 * "unlisted" would mean nothing more than "guess the slug".
 */
export const contentProxy = onRequest(PLAIN, async (req, res) => {
  if (rejectMethod(req, res, ["GET", "HEAD"])) return;

  // Uncacheable until something deliberately says otherwise. See noStore().
  noStore(res);

  const caller = await resolveCaller(req);

  const segments = pathSegments(req, "content");
  if (!segments || segments.length < 2) {
    res.status(404).end();
    return;
  }
  const [docId, versionId] = segments;
  const relParts = segments.slice(2);
  const relPath = relParts.length > 0 ? relParts.join("/") : "index.html";

  const prefix = `docs/${docId}/${versionId}/`;
  const objectKey = `${prefix}${relPath}`;
  // Defence in depth: the resolved key must stay under the version prefix even
  // if a segment check above were ever loosened.
  if (!objectKey.startsWith(prefix) || objectKey.includes("..")) {
    res.status(404).end();
    return;
  }

  const docSnap = await db().collection("docs").doc(docId).get();
  if (!docSnap.exists) {
    res.status(404).end();
    return;
  }
  const docData = docSnap.data() as DocAclData & { linkToken?: string };
  const visibility = visibilityOf(docData);
  const isOwnMember = caller
    ? isMember(docData, caller.uid, caller.emailLower)
    : false;

  // Expiry is checked HERE, on the one path every byte takes, because it is not
  // in the security rules and cannot be. Same 404 as "you may not read this":
  // an expired document must not become a way to confirm a slug exists.
  if (expiredForReader(docData, caller)) {
    res.status(404).end();
    return;
  }

  if (!isOwnMember) {
    if (visibility === "private") {
      res.status(404).end();
      return;
    }
    if (visibility === "unlisted") {
      const key = strParam(req, "k");
      if (!key || key !== docData.linkToken) {
        res.status(404).end();
        return;
      }
    }
  }

  const versionSnap = await docSnap.ref.collection("versions").doc(versionId).get();
  if (!versionSnap.exists) {
    res.status(404).end();
    return;
  }

  // Cache policy is set HERE rather than in firebase.json, because gated and
  // non-private content need different answers and a Hosting header rule would
  // force one on both. Versions are immutable, so public bytes can never be
  // stale; the real exposure is revocation latency, bounded to this window and
  // documented in docs/operations.md.
  if (visibility === "private" || isOwnMember) {
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
    const at = expiryMs(docData);
    const left = at === null ? PUBLIC_CACHE_SECONDS : Math.floor((at - Date.now()) / 1000);
    const maxAge = Math.max(0, Math.min(PUBLIC_CACHE_SECONDS, left));
    res.setHeader("Cache-Control", `public, max-age=${maxAge}`);
  }
  if (visibility === "unlisted") {
    res.setHeader("X-Robots-Tag", "noindex");
  }
  // Deliberately NO X-Frame-Options or frame-ancestors: the content must embed
  // same-origin in the app's iframe, which is what makes annotation possible.

  streamObject(res, objectKey, relPath, req.method === "HEAD");
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
  const docData = docSnap.data() as DocAclData & { slug?: string; linkToken?: string };
  if (expiredForReader(docData, caller)) {
    res.status(404).end();
    return;
  }
  const isOwnMember = caller ? isMember(docData, caller.uid, caller.emailLower) : false;
  if (!isOwnMember) {
    const visibility = visibilityOf(docData);
    if (visibility === "private") {
      res.status(404).end();
      return;
    }
    if (visibility === "unlisted" && strParam(req, "k") !== docData.linkToken) {
      res.status(404).end();
      return;
    }
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
    viewers: state.viewers,
    editors: state.editors,
  });
}

/** Role of an effective member, for the invitation copy. */
function roleOf(email: string, editorMembers: readonly string[]): Role {
  return editorMembers.includes(email) ? "editor" : "viewer";
}

/**
 * POST /access — owner-only sharing changes.
 *
 * `add` accepts a plain email or a `team:{id}` grant. Both are stored as grants
 * and expanded server-side into the flat `members` array, so the Firestore list
 * rule and the workspace query are untouched by teams existing at all (SPEC §18).
 */
export const setAccess = onRequest(MAILING, async (req, res) => {
  if (rejectMethod(req, res, ["POST"])) return;
  const caller = await resolveCaller(req);
  if (!caller) {
    res.status(401).end();
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
    res.status(403).end();
    return;
  }

  const beforeMembers = asArray(data.members);
  const next = applyAccessDelta(
    {
      viewers: asArray(data.viewers),
      editors: asArray(data.editors),
    },
    String(data.ownerEmail),
    parsed.delta,
  );

  // Recompute EFFECTIVE membership rather than just writing the new grants:
  // otherwise a direct-sharing change silently drops every reader who had access
  // through the parent folder. That was a real defect in the original CLI, and
  // it is structurally impossible here because there is one function that
  // computes membership and everything calls it.
  const membership = await persistDocMembership(db(), ref, {
    ownerEmail: String(data.ownerEmail),
    viewers: next.viewers,
    editors: next.editors,
    folderId: (data.folderId as string | null) ?? null,
  });

  const actor = actorFrom(caller, req);
  await logAclChange(ref, actor, beforeMembers, membership.members, next);

  // Invitations go to people who NEWLY gained access, computed from the
  // effective set. That definition covers a team grant for free, and it can
  // never fire on a re-save of the same list.
  const beforeSet = new Set(beforeMembers);
  const invitees: InviteTarget[] = membership.members
    .filter((e) => !beforeSet.has(e) && e !== caller.emailLower)
    .map((email) => ({ email, role: roleOf(email, membership.editorMembers) }));
  if (invitees.length > 0) {
    await sendInvitations(caller.emailLower, invitees, {
      title: typeof data.title === "string" ? data.title : docId,
      kind: "document",
      url: `${publicOrigin()}/d/${docId}`,
    });
  }

  res.status(200).json({
    viewers: next.viewers,
    editors: next.editors,
    members: membership.members,
  });
});

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
    res.status(403).end();
    return;
  }

  const update: Record<string, unknown> = {
    visibility,
    publicEdit: body?.publicEdit === true && visibility !== "private",
    expiresAt:
      expiry.value === null
        ? FieldValue.delete()
        : admin.firestore.Timestamp.fromMillis(expiry.value),
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
  await ref.set(update, { merge: true });
  await syncPublicProjection(db(), docId);
  // Open editing widens who may write the SHARED document too, and the RTDB
  // gate is a mirror rather than a query, so it has to be told.
  await syncPresenceAccess(
    docId,
    asArray(data.members),
    asArray(data.editorMembers),
    update.publicEdit === true,
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
  if (!canManageSharing(snap.data() as DocAclData, caller.emailLower)) {
    res.status(403).end();
    return;
  }

  await ref.set({ trusted, updatedAt: now() }, { merge: true });
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
  if (!canManageSharing(snap.data() as DocAclData, caller.emailLower)) {
    res.status(403).end();
    return;
  }

  await ref.set({ marking, updatedAt: now() }, { merge: true });
  res.status(200).json({ marking });
});

// ---------------------------------------------------------------------------
// Inline editing: draft, draft read-back, commit
// ---------------------------------------------------------------------------

interface VersionMeta {
  entry: string;
  format: "html" | "markdown";
  sourceEntry?: string;
}

async function loadVersionMeta(
  docRef: admin.firestore.DocumentReference,
  versionId: string,
): Promise<VersionMeta | null> {
  const snap = await docRef.collection("versions").doc(versionId).get();
  if (!snap.exists) return null;
  const v = snap.data() || {};
  const entry = typeof v.entry === "string" ? safeRelPath(v.entry) : null;
  if (!entry) return null;
  return {
    entry,
    format: v.format === "markdown" ? "markdown" : "html",
    sourceEntry:
      typeof v.sourceEntry === "string"
        ? (safeRelPath(v.sourceEntry) ?? undefined)
        : undefined,
  };
}

/** Every object under a Storage prefix, as in-memory bundle files. */
async function readPrefix(prefix: string): Promise<BundleFile[]> {
  const [objects] = await bucket().getFiles({ prefix });
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
 * Append this editor to the draft's session log, or extend their open entry.
 *
 * Derived from actual saves rather than from lock transitions, which is both
 * simpler and better evidence: the lock says who HELD the right to edit, the
 * saves say who actually wrote. When the lock changes hands twice in one draft,
 * `lastEditedByEmail` alone cannot answer "who wrote v3" — this can (SPEC §17).
 */
function appendEditSession(
  existing: unknown,
  actor: Actor,
): { email: string; actor: Actor; from: number; to: number }[] {
  const list = Array.isArray(existing)
    ? (existing as { email: string; actor: Actor; from: number; to: number }[])
    : [];
  const stamp = Date.now();
  const last = list[list.length - 1];
  if (last && last.email === actor.email && last.actor?.channel === actor.channel) {
    last.to = stamp;
    return list.slice(-50);
  }
  return [...list, { email: actor.email, actor, from: stamp, to: stamp }].slice(-50);
}

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
  if (!canEdit(data, caller)) {
    res.status(403).end();
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

  const prefix = `docs/${docId}/draft/`;
  let bytes = 0;
  let sourceEntry: string | undefined;

  if (version.format === "markdown") {
    const markdown = htmlToMarkdown(html);
    const rendered = renderMarkdown(markdown, { title: data.title });
    sourceEntry = version.sourceEntry ?? "index.md";
    await bucket()
      .file(`${prefix}${sourceEntry}`)
      .save(Buffer.from(markdown, "utf8"), {
        contentType: "text/markdown; charset=utf-8",
        resumable: false,
      });
    const htmlBuf = Buffer.from(rendered.html, "utf8");
    await bucket().file(`${prefix}${version.entry}`).save(htmlBuf, {
      contentType: "text/html; charset=utf-8",
      resumable: false,
    });
    bytes = Buffer.byteLength(markdown, "utf8");
  } else {
    const htmlBuf = Buffer.from(html, "utf8");
    await bucket().file(`${prefix}${version.entry}`).save(htmlBuf, {
      contentType: "text/html; charset=utf-8",
      resumable: false,
    });
    bytes = htmlBuf.length;
  }

  const actor = actorFrom(caller, req);
  const draft = {
    baseVersion,
    entry: version.entry,
    ...(sourceEntry ? { sourceEntry } : {}),
    bytes,
    updatedByEmail: caller.emailLower,
    editSessions: appendEditSession(data.draft?.editSessions, actor),
  };

  await ref.set(
    {
      draft: { ...draft, updatedAt: now() },
      updatedAt: now(),
      // Edit provenance, folded into a write that was happening anyway. The
      // draft is cleared on commit, so without this the "last edited by" signal
      // would vanish the moment a version is published. A nested map under
      // set/merge deep-merges, leaving the view counters alone.
      stats: { lastEditedAt: now(), lastEditedByEmail: caller.emailLower },
    },
    { merge: true },
  );

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
  if (!canEdit(docData, caller)) {
    res.status(403).end();
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
  if (!canEdit(data, caller)) {
    res.status(403).end();
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
  const draft = data.draft;
  if (!draft || typeof draft.entry !== "string") {
    res.status(409).json({ error: "There is no draft to publish." });
    return;
  }

  // No new version while comments on the current one are open. Annotations are
  // version-scoped, so publishing would leave them behind on a version nobody
  // is reading any more.
  const unresolved = await docRef
    .collection("versions")
    .doc(baseVersion)
    .collection("annotations")
    .where("resolved", "==", false)
    .count()
    .get();
  const unresolvedCount = unresolved.data().count;
  if (unresolvedCount > 0) {
    res.status(409).json({
      error: "Resolve all comments before publishing a new version.",
      unresolvedCount,
    });
    return;
  }

  const version = await loadVersionMeta(docRef, baseVersion);
  if (!version) {
    res.status(409).json({ error: "the base version is missing" });
    return;
  }

  // Assemble: base assets, with anything the draft carries overriding it. That
  // one rule covers both formats — for Markdown the draft carries index.md and
  // index.html, for HTML just the entry — with no branch here.
  const basePrefix = `docs/${docId}/${baseVersion}/`;
  const draftPrefix = `docs/${docId}/draft/`;
  const baseFiles = await readPrefix(basePrefix);
  const draftFiles = await readPrefix(draftPrefix);
  const byRel = new Map<string, Buffer>();
  for (const f of baseFiles) byRel.set(f.rel, f.data);
  for (const f of draftFiles) byRel.set(f.rel, f.data);
  const files: BundleFile[] = [...byRel].map(([rel, data]) => ({ rel, data }));
  const totalBytes = files.reduce((n, f) => n + f.data.length, 0);
  if (totalBytes > MAX_BUNDLE_BYTES) {
    res.status(409).json({ error: "bundle too large to publish" });
    return;
  }
  if (files.length === 0) {
    res.status(409).json({ error: "base version has no content to publish" });
    return;
  }

  const { contentHash, fileCount, bytes } = hashBundleFiles(files);
  const versionsRef = docRef.collection("versions");

  const dup = await versionsRef.where("contentHash", "==", contentHash).limit(1).get();
  if (!dup.empty) {
    await docRef.set(
      { draft: FieldValue.delete(), updatedAt: now() },
      { merge: true },
    );
    await bucket().deleteFiles({ prefix: draftPrefix, force: true });
    res.status(200).json({
      versionId: dup.docs[0].id,
      contentHash,
      fileCount,
      bytes,
      deduped: true,
    });
    return;
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
  const storagePrefix = `docs/${docId}/${versionId}`;

  for (const f of files) {
    await bucket().file(`${storagePrefix}/${f.rel}`).save(f.data, {
      contentType: mime.lookup(f.rel) || "application/octet-stream",
      resumable: false,
    });
  }

  const actor = actorFrom(caller, req);
  const editSessions = Array.isArray(draft.editSessions) ? draft.editSessions : [];

  try {
    await db().runTransaction(async (tx) => {
      const cur = await tx.get(docRef);
      if ((cur.data()?.currentVersion as string) !== baseVersion) throw new Error("STALE");
      const vRef = versionsRef.doc(versionId);
      if ((await tx.get(vRef)).exists) throw new Error("CONFLICT");
      tx.set(vRef, {
        versionId,
        label: versionId,
        entry: version.entry,
        format: version.format,
        ...(version.sourceEntry ? { sourceEntry: version.sourceEntry } : {}),
        ...(version.format === "markdown"
          ? { rendererVersion: renderMarkdown("", {}).rendererVersion }
          : {}),
        storagePrefix,
        fileCount,
        bytes,
        contentHash,
        files: files.map((f) => f.rel),
        parentVersion: baseVersion,
        publishedVia: isAutomated(actor) ? actor.channel : "editor",
        publishedByEmail: caller.emailLower,
        publishedBy: actor,
        editSessions,
        publishedAt: now(),
      });
      tx.set(
        docRef,
        {
          currentVersion: versionId,
          draft: FieldValue.delete(),
          // `trusted` is deliberately untouched, so it PROPAGATES: a document
          // the owner trusted stays trusted across in-app edits. Safe because
          // platform editing is parent-driven and cannot introduce a new
          // uploaded bundle — re-upload and duplicate both make fresh
          // trusted:false documents.
          updatedAt: now(),
          stats: {
            commits: FieldValue.increment(1),
            lastEditedAt: now(),
            lastEditedByEmail: caller.emailLower,
          },
        },
        { merge: true },
      );
    });
  } catch (e) {
    const reason = (e as Error).message;
    if (reason === "STALE" || reason === "CONFLICT") {
      const fresh = await docRef.get();
      res.status(409).json({
        error: "Another editor just published. Reload before publishing.",
        currentVersion: fresh.data()?.currentVersion,
      });
      return;
    }
    throw e;
  }

  await bucket().deleteFiles({ prefix: draftPrefix, force: true });
  await syncPublicProjection(db(), docId);

  res.status(200).json({ versionId, contentHash, fileCount, bytes, deduped: false });
});

// ---------------------------------------------------------------------------
// Workspace: upload, folders, organize, duplicate
// ---------------------------------------------------------------------------

/**
 * POST /publish (createDoc) — a NEW document from a browser upload.
 *
 * The raw request body is the file; metadata rides in the query string. Created
 * `trusted: false`: the uploader is not necessarily the author, so the viewer
 * sandboxes its scripts until somebody with standing says otherwise (SPEC §6c).
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
  const filename = strParam(req, "filename");
  const extracted = extractBundle(buffer, filename, MAX_BUNDLE_BYTES);
  if ("error" in extracted) {
    badRequest(res, extracted.error);
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
  }).catch((e: Error) => e);

  if (result instanceof Error) {
    res.status(500).json({ error: "could not create the document" });
    return;
  }
  res.status(200).json(result);
});

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
 */
export const setFolderAccess = onRequest(MAILING, async (req, res) => {
  if (rejectMethod(req, res, ["POST"])) return;
  const caller = await resolveCaller(req);
  if (!caller) {
    res.status(401).end();
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
  const next = applyAccessDelta(
    { viewers: asArray(data.viewers), editors: asArray(data.editors) },
    String(data.ownerEmail),
    parsed.delta,
  );

  await ref.set({ viewers: next.viewers, editors: next.editors, updatedAt: now() }, { merge: true });
  await recomputeSubtree(db(), folderId);

  const fresh = await ref.get();
  const afterMembers = asArray(fresh.data()?.members);
  const afterEditors = asArray(fresh.data()?.editorMembers);
  const beforeSet = new Set(beforeMembers);
  const invitees: InviteTarget[] = afterMembers
    .filter((e) => !beforeSet.has(e) && e !== caller.emailLower)
    .map((email) => ({ email, role: roleOf(email, afterEditors) }));
  if (invitees.length > 0) {
    await sendInvitations(caller.emailLower, invitees, {
      title: typeof data.name === "string" ? data.name : "a folder",
      kind: "folder",
      url: `${publicOrigin()}/folder/${folderId}`,
    });
  }

  res.status(200).json({ viewers: next.viewers, editors: next.editors });
});

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
    if (!canEdit(data, caller)) {
      res.status(403).end();
      return;
    }

    if (op === "delete") {
      badRequest(res, "deleting documents is not supported");
      return;
    }
    if (op === "rename") {
      const name = typeof body?.name === "string" ? body.name.trim() : "";
      if (!name || name.length > 200) {
        badRequest(res, "title is required (up to 200 characters)");
        return;
      }
      await ref.set({ title: name, slug: slugify(name), updatedAt: now() }, { merge: true });
      await syncPublicProjection(db(), id);
      res.status(200).json({ ok: true });
      return;
    }

    const target = await resolveFolderTarget(db(), body?.targetFolderId, caller);
    if (!target.ok) {
      res.status(target.status).json({ error: target.error });
      return;
    }
    await persistDocMembership(
      db(),
      ref,
      {
        ownerEmail: String(data.ownerEmail || ""),
        viewers: asArray(data.viewers),
        editors: asArray(data.editors),
        folderId: target.id,
      },
      { folderId: target.id },
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
        viewers: asArray(dd.viewers),
        editors: asArray(dd.editors),
        folderId: null,
      });
    }
  }

  await ref.delete();
  res.status(200).json({ ok: true });
});

/**
 * POST /duplicate — copy a document you can READ into a new one you own.
 *
 * The copy is `trusted: false` even when the source was trusted: otherwise
 * duplicating a trusted deck, editing it, and re-publishing would launder
 * arbitrary script into a document with somebody else's trust decision attached.
 */
export const duplicateDoc = onRequest(PLAIN, async (req, res) => {
  if (rejectMethod(req, res, ["POST"])) return;
  const caller = await resolveCaller(req);
  if (!caller) {
    res.status(401).end();
    return;
  }

  const body = jsonBody(req) as { docId?: unknown; folderId?: unknown } | null;
  const srcId = typeof body?.docId === "string" ? body.docId : "";
  if (!srcId || !safeSegment(srcId)) {
    badRequest(res, "invalid or missing docId");
    return;
  }

  const srcSnap = await db().collection("docs").doc(srcId).get();
  if (!srcSnap.exists) {
    res.status(404).end();
    return;
  }
  const src = srcSnap.data() as DocAclData & { title?: string; currentVersion?: string };
  if (!canRead(src, caller)) {
    res.status(403).end();
    return;
  }
  // Duplicating reads every byte of the source, so it is a read path — and
  // without this, copying an expired document would be a way to get its content
  // back out from behind the date.
  if (expiredForReader(src, caller)) {
    res.status(404).end();
    return;
  }
  const srcVersion = typeof src.currentVersion === "string" ? src.currentVersion : "";
  if (!srcVersion || !safeSegment(srcVersion)) {
    res.status(409).json({ error: "the source document has no published version" });
    return;
  }
  const vSnap = await srcSnap.ref.collection("versions").doc(srcVersion).get();
  if (!vSnap.exists) {
    res.status(409).json({ error: "the source version is missing" });
    return;
  }
  const v = vSnap.data() || {};

  const folderId = typeof body?.folderId === "string" ? body.folderId : "";
  let parentMembership: Membership | null = null;
  let resolvedFolderId: string | null = null;
  if (folderId && safeSegment(folderId)) {
    const fSnap = await db().collection("folders").doc(folderId).get();
    if (
      fSnap.exists &&
      canEditFolder(fSnap.data() as FolderAclData, caller.uid, caller.emailLower)
    ) {
      parentMembership = {
        members: asArray(fSnap.data()?.members),
        editorMembers: asArray(fSnap.data()?.editorMembers),
      };
      resolvedFolderId = folderId;
    }
  }

  const title = `${typeof src.title === "string" ? src.title : "Untitled"} (copy)`;
  const newId = await uniqueDocId(db(), slugify(title));
  const versionId = "v1";
  const destPrefix = `docs/${newId}/${versionId}`;
  const srcPrefix = `docs/${srcId}/${srcVersion}/`;

  const [objects] = await bucket().getFiles({ prefix: srcPrefix });
  let copied = 0;
  for (const obj of objects) {
    const rel = obj.name.slice(srcPrefix.length);
    if (rel.length === 0 || rel.endsWith("/")) continue;
    await obj.copy(`${destPrefix}/${rel}`);
    copied++;
  }
  if (copied === 0) {
    res.status(409).json({ error: "the source has no content to copy" });
    return;
  }

  const membership = computeDocMembership(caller.emailLower, [], [], parentMembership);
  const actor = actorFrom(caller, req);
  const docRef = db().collection("docs").doc(newId);
  const batch = db().batch();
  batch.create(docRef, {
    docId: newId,
    title,
    slug: slugify(title),
    ownerUid: caller.uid,
    ownerEmail: caller.emailLower,
    currentVersion: versionId,
    viewers: [],
    editors: [],
    members: membership.members,
    editorMembers: membership.editorMembers,
    folderId: resolvedFolderId,
    visibility: "private",
    publicEdit: false,
    trusted: false,
    marking: resolveMarking(null),
    createdAt: now(),
    updatedAt: now(),
  });
  batch.create(docRef.collection("versions").doc(versionId), {
    versionId,
    label: versionId,
    entry: typeof v.entry === "string" ? v.entry : "index.html",
    format: v.format === "markdown" ? "markdown" : "html",
    ...(typeof v.sourceEntry === "string" ? { sourceEntry: v.sourceEntry } : {}),
    ...(typeof v.rendererVersion === "string"
      ? { rendererVersion: v.rendererVersion }
      : {}),
    storagePrefix: destPrefix,
    fileCount: typeof v.fileCount === "number" ? v.fileCount : copied,
    bytes: typeof v.bytes === "number" ? v.bytes : 0,
    contentHash: typeof v.contentHash === "string" ? v.contentHash : "",
    ...(Array.isArray(v.files) ? { files: v.files } : {}),
    parentVersion: null,
    publishedVia: "duplicate",
    publishedByEmail: caller.emailLower,
    publishedBy: actor,
    publishedAt: now(),
  });
  try {
    await batch.commit();
  } catch {
    res.status(500).json({ error: "could not create the copy" });
    return;
  }

  await syncPresenceAccess(newId, membership.members, membership.editorMembers);
  res.status(200).json({ docId: newId, versionId, title });
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
  const caller = await resolveCaller(req);

  const body = jsonBody(req) as {
    docId?: unknown;
    versionId?: unknown;
    sessionId?: unknown;
    ms?: unknown;
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
  if (!canRead(docData, caller) || expiredForReader(docData, caller)) {
    res.status(404).end();
    return;
  }

  const actor = caller ? actorFrom(caller, req) : null;
  const automated = actor ? isAutomated(actor) : false;
  const via: "app" | "unlisted" | "public" =
    caller && isMember(docData, caller.uid, caller.emailLower)
      ? "app"
      : visibilityOf(docData) === "unlisted"
        ? "unlisted"
        : "public";

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
  // Deliberately session-only: minting a credential with a credential is how a
  // leaked token becomes permanent access.
  const cookieHeader = cookie.parse(req.headers.cookie || "")[SESSION_COOKIE_NAME];
  const caller = cookieHeader ? await verifySessionCookie(cookieHeader) : null;
  if (!caller) {
    res.status(401).end();
    return;
  }

  const body = jsonBody(req) as {
    op?: unknown;
    name?: unknown;
    channel?: unknown;
    tokenId?: unknown;
  } | null;
  const op = body?.op;

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
 * That is a batch, and the trade is written down in docs/architecture.md rather
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
      viewers: asArray(d.viewers),
      editors: asArray(d.editors),
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
    for (const c of siblingSnap.docs) {
      const e = normalizeEmail(String(c.data()?.authorEmail || ""));
      if (e) recipients.add(e);
    }
    recipients.delete(authorEmail);
    if (recipients.size === 0) return;

    const quote = String(annSnap.data()?.anchor?.exact ?? "").slice(0, 300);
    const body = String(comment.body ?? "").slice(0, 2000);
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
      if (!(await claimCommentCooldown(db(), uid, docId))) continue;
      await sendCommentNotice(email, {
        authorEmail,
        docTitle: title,
        quote,
        body,
        viaChannel,
        docId,
        versionId,
      });
    }
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
  const { handleMcp } = await import("./mcp/server");
  await handleMcp(req, res);
});
