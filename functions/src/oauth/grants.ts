// SPDX-License-Identifier: Apache-2.0
// A connected app's grant in the token store: mint, rotate, verify, re-check (SPEC §23).

import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import * as admin from "firebase-admin";
import { FieldValue, Timestamp, type Transaction } from "firebase-admin/firestore";
import { isAllowedEmail } from "../generated/policy";
import { revokeToken, type VerifiedToken } from "../lib/tokens";
import type { Registration } from "./clients";

type Db = admin.firestore.Firestore;

/**
 * A grant is one connected app, and it is a row in `tokens/`.
 *
 * Living beside personal access tokens is what makes the account screen show
 * it and revoke it with no new code: revocation is the same `revokedAt` on the
 * same two documents. The `tokenId` is stable for the life of the connection,
 * so "what did this app do" stays one query however often its secrets rotate.
 *
 * A grant never has a `hash` field — that is a personal token's — so the
 * personal-token check can never accept one, and the reverse holds by prefix.
 *
 *   access   bsa_<tokenId>.<secret>   one hour, /mcp only
 *   refresh  bsr_<tokenId>.<secret>   rotates on use; lapses after 90 days unused
 */
export const ACCESS_PREFIX = "bsa_";
export const REFRESH_PREFIX = "bsr_";
const ACCESS_RE = /^bsa_([0-9a-f]{32})\.([A-Za-z0-9_-]{43})$/;
const REFRESH_RE = /^bsr_([0-9a-f]{32})\.([A-Za-z0-9_-]{43})$/;

export const ACCESS_TTL_MS = 60 * 60 * 1000;
export const REFRESH_IDLE_MS = 90 * 24 * 60 * 60 * 1000;
/**
 * How long a retry of the same exchange gets the same answer.
 *
 * A client that times out waiting — Claude gives the token endpoint ten
 * seconds, and a cold start can take most of that — retries with the token it
 * still holds. Answering that with a NEW pair forks the chain: the client keeps
 * one and the other is a stranger, and the next refresh looks like theft. So a
 * retry inside this window gets the pair it missed, byte for byte.
 */
export const REPLAY_GRACE_MS = 60 * 1000;

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sameHash(expectedHex: unknown, value: string): boolean {
  if (typeof expectedHex !== "string" || expectedHex.length !== 64) return false;
  const a = Buffer.from(expectedHex, "hex");
  const b = Buffer.from(sha256(value), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The secrets after a rotation, derived rather than drawn.
 *
 * Keyed by the secret being spent and salted with a nonce only the server
 * holds, so the same spend always yields the same pair — which is what lets a
 * retry be answered identically without storing a plaintext — and holding an
 * old secret is not enough to compute the next one.
 */
export function derivePair(secret: string, nonce: string): { access: string; refresh: string } {
  const derive = (label: string) =>
    createHmac("sha256", secret).update(`${nonce}:${label}`, "utf8").digest("base64url");
  return { access: derive("access"), refresh: derive("refresh") };
}

export interface TokenPair {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
}

function pairFor(tokenId: string, secrets: { access: string; refresh: string }, accessExpiresMs: number): TokenPair {
  return {
    access_token: `${ACCESS_PREFIX}${tokenId}.${secrets.access}`,
    token_type: "Bearer",
    expires_in: Math.max(0, Math.floor((accessExpiresMs - Date.now()) / 1000)),
    refresh_token: `${REFRESH_PREFIX}${tokenId}.${secrets.refresh}`,
  };
}

export function isAccessTokenShaped(presented: string | null | undefined): boolean {
  return typeof presented === "string" && ACCESS_RE.test(presented);
}

/** What an authorization code was issued for, as the token endpoint reads it back. */
export interface CodeRecord {
  uid: string;
  emailLower: string;
  clientId: string;
  clientName: string;
  clientHost: string | null;
  clientVerified: boolean;
  registration: Registration;
  redirectUri: string;
  /** Where the person was sent back to, for the account screen; null for loopback. */
  redirectHost: string | null;
  codeChallenge: string;
  resource: string;
  device: string | null;
}

/**
 * Write a new grant inside the transaction that spends its code.
 *
 * The first pair is derived from the code itself, so a retried exchange inside
 * the grace window can be answered with the same pair.
 */
export function createGrant(
  db: Db,
  tx: Transaction,
  code: string,
  record: CodeRecord,
  nonce: string,
): { tokenId: string; pair: TokenPair } {
  const tokenId = randomBytes(16).toString("hex");
  const secrets = derivePair(code, nonce);
  const now = Date.now();
  const accessExpiresMs = now + ACCESS_TTL_MS;
  const refreshExpires = Timestamp.fromMillis(now + REFRESH_IDLE_MS);
  // The host the account screen shows: the verified one, else where the person
  // is sent back to, else nothing (a program on their own computer).
  const shownHost = record.clientHost ?? record.redirectHost;
  tx.set(db.collection("tokens").doc(tokenId), {
    tokenId,
    kind: "oauth",
    uid: record.uid,
    email: record.emailLower,
    name: record.clientName,
    channel: "mcp",
    client: {
      id: record.clientId,
      host: record.clientHost,
      verified: record.clientVerified,
      registration: record.registration,
    },
    resource: record.resource,
    accessHash: sha256(secrets.access),
    accessExpiresAt: Timestamp.fromMillis(accessExpiresMs),
    refreshHash: sha256(secrets.refresh),
    refreshExpiresAt: refreshExpires,
    prevRefreshHash: null,
    nonce,
    generation: 0,
    rotatedAt: null,
    createdAt: FieldValue.serverTimestamp(),
    createdAtMs: now,
    revokedAt: null,
  });
  tx.set(db.collection("users").doc(record.uid).collection("tokens").doc(tokenId), {
    tokenId,
    kind: "oauth",
    name: record.clientName,
    channel: "mcp",
    clientHost: shownHost,
    clientVerified: record.clientVerified,
    registration: record.registration === "cimd" ? "cimd" : "dcr",
    createdAt: FieldValue.serverTimestamp(),
    expiresAt: refreshExpires,
    revokedAt: null,
  });
  return { tokenId, pair: pairFor(tokenId, secrets, accessExpiresMs) };
}

/** The pair a code already produced, for a retry inside the grace window. */
export function replayCodePair(tokenId: string, code: string, nonce: string, accessExpiresMs: number): TokenPair {
  return pairFor(tokenId, derivePair(code, nonce), accessExpiresMs);
}

interface GrantRecord {
  kind?: string;
  uid: string;
  email: string;
  client?: { id?: string };
  resource?: string;
  accessHash?: string;
  accessExpiresAt?: Timestamp;
  refreshHash?: string;
  refreshExpiresAt?: Timestamp;
  prevRefreshHash?: string | null;
  nonce?: string;
  generation?: number;
  rotatedAt?: Timestamp | null;
  createdAtMs?: number;
  revokedAt?: Timestamp | null;
}

const millis = (t: Timestamp | null | undefined) => (t && typeof t.toMillis === "function" ? t.toMillis() : 0);

/**
 * Verify an access token presented to /mcp.
 *
 * Null for anything wrong, for the same reason as a personal token: telling
 * the caller which part failed would make this an oracle. The resource it was
 * issued for must be one of this deployment's MCP addresses (RFC 8707); a
 * token is never accepted anywhere else, because `resolveCaller` does not know
 * this prefix.
 */
export async function verifyAccessToken(
  db: Db,
  presented: string,
  allowedResources: readonly string[],
): Promise<VerifiedToken | null> {
  const match = ACCESS_RE.exec(presented ?? "");
  if (!match) return null;
  const [, tokenId, secret] = match;
  const snap = await db.collection("tokens").doc(tokenId).get();
  if (!snap.exists) return null;
  const g = snap.data() as GrantRecord;
  if (g.kind !== "oauth" || g.revokedAt != null) return null;
  if (!sameHash(g.accessHash, secret)) return null;
  if (millis(g.accessExpiresAt) <= Date.now()) return null;
  if (typeof g.resource !== "string" || !allowedResources.includes(g.resource)) return null;

  const now = FieldValue.serverTimestamp();
  void db
    .batch()
    .set(snap.ref, { lastUsedAt: now }, { merge: true })
    .set(db.collection("users").doc(g.uid).collection("tokens").doc(tokenId), { lastUsedAt: now }, { merge: true })
    .commit()
    .catch(() => {
      /* touch is best-effort */
    });

  return { tokenId, uid: g.uid, emailLower: g.email, channel: "mcp" };
}

/**
 * Is the person behind a grant still someone this deployment admits?
 *
 * A personal token asks on every use (lib/tokens.ts). An OAuth grant asks at
 * every refresh, so a disabled account, an unverified or changed address, a
 * narrowed allowlist, or "sign out everywhere" ends the connection within an
 * hour.
 *
 * "unknown" is not "closed". A failed lookup must not disconnect anyone: a
 * client told `invalid_grant` throws the connection away, and one permission
 * blip would then disconnect every app every person has.
 */
export async function gateStillOpen(
  uid: string,
  emailLower: string,
  createdAtMs: number,
): Promise<"ok" | "closed" | "unknown"> {
  let user: admin.auth.UserRecord;
  try {
    user = await admin.auth().getUser(uid);
  } catch (err) {
    if ((err as { code?: string })?.code === "auth/user-not-found") return "closed";
    console.error("gate re-check failed:", (err as Error)?.message ?? err);
    return "unknown";
  }
  if (user.disabled) return "closed";
  if (user.emailVerified !== true) return "closed";
  const email = typeof user.email === "string" ? user.email.toLowerCase() : "";
  if (!email || email !== emailLower) return "closed";
  if (!isAllowedEmail(email)) return "closed";
  const validAfter = user.tokensValidAfterTime ? Date.parse(user.tokensValidAfterTime) : 0;
  if (Number.isFinite(validAfter) && validAfter > createdAtMs) return "closed";
  return "ok";
}

export type RefreshResult =
  | { ok: true; pair: TokenPair }
  | { ok: false; status: 400; error: "invalid_grant" | "invalid_target"; description: string }
  | { ok: false; status: 500; error: "server_error"; description: string };

const invalidGrant = (description: string): RefreshResult => ({
  ok: false,
  status: 400,
  error: "invalid_grant",
  description,
});

/**
 * Spend a refresh token.
 *
 *   current token          rotate both secrets, slide the expiry
 *   previous, inside 60 s  the same pair the first spend produced, no write
 *   previous, after 60 s   somebody else has the old one: revoke the grant
 *   anything else          refuse, and change nothing
 *
 * Revocation requires possession. A `tokenId` is not secret — it is stamped on
 * what a token does, which readers can see — so a wrong secret for a known id
 * must never be able to disconnect anyone.
 */
export async function refreshGrant(
  db: Db,
  presented: string,
  opts: { clientId?: string; resource?: string | null },
): Promise<RefreshResult> {
  const match = REFRESH_RE.exec(presented ?? "");
  if (!match) return invalidGrant("refresh token not recognised");
  const [, tokenId, secret] = match;
  const ref = db.collection("tokens").doc(tokenId);

  let g: GrantRecord;
  try {
    const snap = await ref.get();
    if (!snap.exists) return invalidGrant("refresh token not recognised");
    g = snap.data() as GrantRecord;
  } catch (err) {
    console.error("refresh read failed:", (err as Error)?.message ?? err);
    return { ok: false, status: 500, error: "server_error", description: "try again" };
  }
  if (g.kind !== "oauth") return invalidGrant("refresh token not recognised");
  const isCurrent = sameHash(g.refreshHash, secret);
  const isPrevious = !isCurrent && sameHash(g.prevRefreshHash, secret);
  if (!isCurrent && !isPrevious) return invalidGrant("refresh token not recognised");
  if (g.revokedAt != null) return invalidGrant("this connection was disconnected");
  if (opts.clientId && opts.clientId !== g.client?.id) return invalidGrant("refresh token was issued to another client");
  if (opts.resource && opts.resource !== g.resource) {
    return { ok: false, status: 400, error: "invalid_target", description: "refresh token was issued for another resource" };
  }

  if (isPrevious) {
    const sinceRotation = Date.now() - millis(g.rotatedAt);
    if (sinceRotation <= REPLAY_GRACE_MS && typeof g.nonce === "string") {
      return { ok: true, pair: pairFor(tokenId, derivePair(secret, g.nonce), millis(g.accessExpiresAt)) };
    }
    await revokeToken(db, g.uid, tokenId);
    return invalidGrant("refresh token was already used; the connection has been disconnected");
  }

  if (millis(g.refreshExpiresAt) <= Date.now()) {
    return invalidGrant("this connection lapsed after 90 days without use");
  }

  const gate = await gateStillOpen(g.uid, g.email, g.createdAtMs ?? 0);
  if (gate === "unknown") {
    return { ok: false, status: 500, error: "server_error", description: "try again" };
  }
  if (gate === "closed") {
    await revokeToken(db, g.uid, tokenId);
    return invalidGrant("this account can no longer connect apps");
  }

  try {
    return await db.runTransaction(async (tx) => {
      const fresh = await tx.get(ref);
      const cur = fresh.data() as GrantRecord | undefined;
      if (!cur || cur.revokedAt != null) return invalidGrant("this connection was disconnected");
      // Lost a race to a concurrent spend of the same token: answer as a retry.
      if (!sameHash(cur.refreshHash, secret)) {
        if (sameHash(cur.prevRefreshHash, secret) && typeof cur.nonce === "string") {
          return { ok: true, pair: pairFor(tokenId, derivePair(secret, cur.nonce), millis(cur.accessExpiresAt)) } as RefreshResult;
        }
        return invalidGrant("refresh token not recognised");
      }
      const nonce = randomBytes(16).toString("base64url");
      const secrets = derivePair(secret, nonce);
      const now = Date.now();
      const accessExpiresMs = now + ACCESS_TTL_MS;
      const refreshExpires = Timestamp.fromMillis(now + REFRESH_IDLE_MS);
      tx.set(
        ref,
        {
          accessHash: sha256(secrets.access),
          accessExpiresAt: Timestamp.fromMillis(accessExpiresMs),
          refreshHash: sha256(secrets.refresh),
          refreshExpiresAt: refreshExpires,
          prevRefreshHash: sha256(secret),
          nonce,
          generation: (cur.generation ?? 0) + 1,
          rotatedAt: Timestamp.fromMillis(now),
          lastUsedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      tx.set(
        db.collection("users").doc(cur.uid).collection("tokens").doc(tokenId),
        { expiresAt: refreshExpires, lastUsedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
      return { ok: true, pair: pairFor(tokenId, secrets, accessExpiresMs) } as RefreshResult;
    });
  } catch (err) {
    console.error("refresh rotation failed:", (err as Error)?.message ?? err);
    return { ok: false, status: 500, error: "server_error", description: "try again" };
  }
}
