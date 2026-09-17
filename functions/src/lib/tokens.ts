// SPDX-License-Identifier: Apache-2.0
// Personal access tokens: mint, verify, revoke (SPEC §19).

import { createHash, randomBytes, timingSafeEqual } from "crypto";
import * as admin from "firebase-admin";

type Db = admin.firestore.Firestore;

/**
 * Shape: `bsk_<tokenId>.<secret>`
 *
 * The id travels with the secret so verification is a single point read rather
 * than a scan, and so `tokenId` can be stamped on everything the token touches
 * (SPEC §17). Only a SHA-256 of the secret is stored: a leaked database does not
 * yield working tokens, and the plaintext is shown exactly once, at mint time.
 *
 * The id is hex and the secret is base64url, with `.` between them — `.` is not
 * in either alphabet, so parsing is unambiguous. base64url is, which is why the
 * separator is not `_` or `-`.
 */
const PREFIX = "bsk_";
const ID_BYTES = 16;
const SECRET_BYTES = 32;
const TOKEN_RE = /^bsk_([0-9a-f]{32})\.([A-Za-z0-9_-]{20,64})$/;

/**
 * What a token is FOR, chosen when it is minted and stored server-side.
 *
 * This is what makes `channel` in the provenance record honest. A caller cannot
 * declare "I am the CLI"; the token they present was created as a CLI token, by
 * their own past self, and the server reads that from its own record. The /mcp
 * endpoint overrides to "mcp" regardless, because the endpoint is the stronger
 * signal.
 */
export type TokenChannel = "cli" | "mcp" | "api";

export interface TokenRecord {
  tokenId: string;
  uid: string;
  email: string;
  name: string;
  channel: TokenChannel;
  hash: string;
  createdAt: admin.firestore.Timestamp;
  lastUsedAt?: admin.firestore.Timestamp;
  revokedAt?: admin.firestore.Timestamp | null;
}

/** Metadata safe to show the owner. Never includes the hash. */
export interface TokenSummary {
  tokenId: string;
  name: string;
  channel: TokenChannel;
  createdAt: admin.firestore.Timestamp | null;
  lastUsedAt: admin.firestore.Timestamp | null;
  revoked: boolean;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export interface MintedToken {
  tokenId: string;
  /** Shown once and never stored. */
  plaintext: string;
}

/**
 * Create a token for `uid`.
 *
 * Writes twice on purpose: the authoritative record (with the hash) lives in a
 * top-level collection no client rule grants access to, and a metadata mirror
 * lives under the user so the account screen can list and revoke through the
 * same live Firestore subscription it uses for everything else. Minting is rare;
 * the second write costs nothing worth optimizing.
 */
export async function mintToken(
  db: Db,
  uid: string,
  emailLower: string,
  name: string,
  channel: TokenChannel,
): Promise<MintedToken> {
  const tokenId = randomBytes(ID_BYTES).toString("hex");
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  const plaintext = `${PREFIX}${tokenId}.${secret}`;
  const now = admin.firestore.FieldValue.serverTimestamp();

  const batch = db.batch();
  batch.set(db.collection("tokens").doc(tokenId), {
    tokenId,
    uid,
    email: emailLower,
    name: name.slice(0, 80),
    channel,
    hash: sha256(secret),
    createdAt: now,
    revokedAt: null,
  });
  batch.set(db.collection("users").doc(uid).collection("tokens").doc(tokenId), {
    tokenId,
    name: name.slice(0, 80),
    channel,
    createdAt: now,
    revokedAt: null,
  });
  await batch.commit();

  return { tokenId, plaintext };
}

/** Revoke a token the caller owns. Idempotent. */
export async function revokeToken(
  db: Db,
  uid: string,
  tokenId: string,
): Promise<boolean> {
  const ref = db.collection("tokens").doc(tokenId);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.uid !== uid) return false;
  const now = admin.firestore.FieldValue.serverTimestamp();
  const batch = db.batch();
  batch.set(ref, { revokedAt: now }, { merge: true });
  batch.set(
    db.collection("users").doc(uid).collection("tokens").doc(tokenId),
    { revokedAt: now },
    { merge: true },
  );
  await batch.commit();
  return true;
}

export async function listTokens(db: Db, uid: string): Promise<TokenSummary[]> {
  const snap = await db
    .collection("users")
    .doc(uid)
    .collection("tokens")
    .orderBy("createdAt", "desc")
    .get();
  return snap.docs.map((d) => {
    const t = d.data();
    return {
      tokenId: d.id,
      name: typeof t.name === "string" ? t.name : "",
      channel: (t.channel as TokenChannel) ?? "api",
      createdAt: (t.createdAt as admin.firestore.Timestamp) ?? null,
      lastUsedAt: (t.lastUsedAt as admin.firestore.Timestamp) ?? null,
      revoked: t.revokedAt != null,
    };
  });
}

export interface VerifiedToken {
  tokenId: string;
  uid: string;
  emailLower: string;
  channel: TokenChannel;
}

/**
 * Verify a presented token.
 *
 * Comparison is timing-safe. Returns null for anything wrong — malformed,
 * unknown, revoked, or a hash mismatch — because distinguishing those for the
 * caller would turn this into an oracle for which token ids exist.
 *
 * `lastUsedAt` is updated best-effort and never blocks the request: it exists so
 * an unused token is VISIBLE on the account screen, which is what makes "revoke
 * the one you forgot about" a thing anyone actually does.
 */
export async function verifyToken(
  db: Db,
  presented: string,
): Promise<VerifiedToken | null> {
  const match = TOKEN_RE.exec(presented ?? "");
  if (!match) return null;
  const [, tokenId, secret] = match;

  const snap = await db.collection("tokens").doc(tokenId).get();
  if (!snap.exists) return null;
  const record = snap.data() as TokenRecord;
  if (record.revokedAt != null) return null;
  if (typeof record.hash !== "string") return null;

  const expected = Buffer.from(record.hash, "hex");
  const actual = Buffer.from(sha256(secret), "hex");
  if (expected.length !== actual.length) return null;
  if (!timingSafeEqual(expected, actual)) return null;

  const now = admin.firestore.FieldValue.serverTimestamp();
  void db
    .batch()
    .set(snap.ref, { lastUsedAt: now }, { merge: true })
    .set(
      db.collection("users").doc(record.uid).collection("tokens").doc(tokenId),
      { lastUsedAt: now },
      { merge: true },
    )
    .commit()
    .catch(() => {
      /* touch is best-effort */
    });

  return {
    tokenId,
    uid: record.uid,
    emailLower: record.email,
    channel: record.channel ?? "api",
  };
}

/**
 * True when a presented credential is even shaped like one of ours.
 *
 * Checked before any database handle is constructed, so a stream of garbage
 * Authorization headers costs nothing and cannot be used to probe whether the
 * backend is reachable.
 */
export function isTokenShaped(presented: string | null | undefined): boolean {
  return typeof presented === "string" && TOKEN_RE.test(presented);
}

/** Extract a Bearer credential from an Authorization header. */
export function bearerFrom(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  return m ? m[1] : null;
}
