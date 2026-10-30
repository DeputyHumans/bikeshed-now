// SPDX-License-Identifier: Apache-2.0
// Personal access tokens: mint, verify, revoke (SPEC §19).

import { createHash, randomBytes, timingSafeEqual } from "crypto";
import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { isAllowedEmail } from "../generated/policy";

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
 * their own past self, and the server reads that from its own record. It holds
 * on every endpoint, /mcp included: attribution names the credential, not the
 * door it came through (ADR 0023).
 */
export type TokenChannel = "cli" | "mcp" | "api";

/**
 * What a verified credential reads as: a personal token's own channel, or
 * `app` for an app connected by signing in (SPEC §23).
 */
export type CredentialChannel = TokenChannel | "app";

/**
 * The names `bikeshed login` gives the token it mints (oauth/token.ts), in one
 * place so that `viaLabel` (lib/actor.ts) shows "CLI on mbp" as itself rather
 * than as a token somebody named "CLI on mbp".
 */
export const CLI_LOGIN_PREFIX = "CLI on ";
export const CLI_LOGIN_FALLBACK = "Command line";
export const cliLoginName = (device: string | null | undefined): string =>
  device ? `${CLI_LOGIN_PREFIX}${device}` : CLI_LOGIN_FALLBACK;

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
  /** Present for an app connected by signing in (SPEC §23); absent for a token. */
  kind?: "oauth";
  clientHost?: string | null;
  clientVerified?: boolean;
  registration?: "cimd" | "dcr";
  expiresAt?: admin.firestore.Timestamp | null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export interface MintedToken {
  tokenId: string;
  /** Shown once and never stored. */
  plaintext: string;
}

/** A token's two documents, ready to write, and its plaintext. */
export interface PreparedToken extends MintedToken {
  record: Record<string, unknown>;
  mirror: Record<string, unknown>;
}

/**
 * Build a token without writing it, so a caller can write it inside its own
 * transaction. The OAuth token endpoint mints a CLI token in the same
 * transaction that spends the authorization code, so a retried transaction
 * cannot mint two (SPEC §23).
 */
export function prepareToken(
  uid: string,
  emailLower: string,
  name: string,
  channel: TokenChannel,
): PreparedToken {
  const tokenId = randomBytes(ID_BYTES).toString("hex");
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  const now = FieldValue.serverTimestamp();
  return {
    tokenId,
    plaintext: `${PREFIX}${tokenId}.${secret}`,
    record: {
      tokenId,
      uid,
      email: emailLower,
      name: name.slice(0, 80),
      channel,
      hash: sha256(secret),
      createdAt: now,
      revokedAt: null,
    },
    mirror: {
      tokenId,
      name: name.slice(0, 80),
      channel,
      createdAt: now,
      revokedAt: null,
    },
  };
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
  const prepared = prepareToken(uid, emailLower, name, channel);
  const batch = db.batch();
  batch.set(db.collection("tokens").doc(prepared.tokenId), prepared.record);
  batch.set(
    db.collection("users").doc(uid).collection("tokens").doc(prepared.tokenId),
    prepared.mirror,
  );
  await batch.commit();
  return { tokenId: prepared.tokenId, plaintext: prepared.plaintext };
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
  const now = FieldValue.serverTimestamp();
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
    const summary: TokenSummary = {
      tokenId: d.id,
      name: typeof t.name === "string" ? t.name : "",
      channel: (t.channel as TokenChannel) ?? "api",
      createdAt: (t.createdAt as admin.firestore.Timestamp) ?? null,
      lastUsedAt: (t.lastUsedAt as admin.firestore.Timestamp) ?? null,
      revoked: t.revokedAt != null,
    };
    if (t.kind === "oauth") {
      summary.kind = "oauth";
      summary.clientHost = typeof t.clientHost === "string" ? t.clientHost : null;
      summary.clientVerified = t.clientVerified === true;
      summary.registration = t.registration === "cimd" ? "cimd" : "dcr";
      summary.expiresAt = (t.expiresAt as admin.firestore.Timestamp) ?? null;
    }
    return summary;
  });
}

export interface VerifiedToken {
  tokenId: string;
  uid: string;
  emailLower: string;
  channel: CredentialChannel;
  /** The token's name, or the connected app's: what provenance calls it. */
  name: string;
}

/**
 * Verify a presented token.
 *
 * Comparison is timing-safe. Returns null for anything wrong — malformed,
 * unknown, revoked, a hash mismatch, or an owner whose identity no longer
 * passes the gate — because distinguishing those for the
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
  const record = snap.data() as TokenRecord & { kind?: string };
  if (record.revokedAt != null) return null;
  // A connected app's grant lives in this collection too, under the same id
  // space, and carries no `hash`. Refusing it by kind as well means a grant id
  // dressed as a personal token is refused even if a field is ever added.
  if (record.kind === "oauth") return null;
  if (typeof record.hash !== "string") return null;

  const expected = Buffer.from(record.hash, "hex");
  const actual = Buffer.from(sha256(secret), "hex");
  if (expected.length !== actual.length) return null;
  if (!timingSafeEqual(expected, actual)) return null;

  // A personal token has no expiry or refresh step. Re-read Auth on every use
  // so disabling/deleting an account cannot leave an indefinite bearer route
  // around the browser's identity gate. A changed address must mint new tokens:
  // the old token must never retain the old address's grants.
  let user: admin.auth.UserRecord;
  try {
    user = await admin.auth().getUser(record.uid);
  } catch (err) {
    if ((err as { code?: string })?.code !== "auth/user-not-found") {
      console.error("personal token identity check failed:", (err as Error)?.message ?? err);
    }
    return null;
  }
  const email = typeof user.email === "string" ? user.email.toLowerCase() : "";
  if (user.disabled || user.emailVerified !== true || !email || email !== record.email || !isAllowedEmail(email)) {
    return null;
  }

  const now = FieldValue.serverTimestamp();
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
    name: typeof record.name === "string" ? record.name : "",
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
