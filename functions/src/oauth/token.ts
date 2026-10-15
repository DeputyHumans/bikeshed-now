// SPDX-License-Identifier: Apache-2.0
// POST /oauth/token: spend an authorization code or a refresh token (SPEC §23).

import { createHash, randomBytes, timingSafeEqual } from "crypto";
import * as admin from "firebase-admin";
import { Timestamp } from "firebase-admin/firestore";
import type { Request } from "firebase-functions/v2/https";
import type { Response } from "express";
import { jsonBody, rejectMethod } from "../lib/http";
import { prepareToken, revokeToken } from "../lib/tokens";
import { CLI_CLIENT_ID } from "./clients";
import {
  REPLAY_GRACE_MS,
  createGrant,
  refreshGrant,
  replayCodePair,
  type CodeRecord,
} from "./grants";
import { canonicalResource } from "./metadata";

type Fields = Map<string, string>;

/**
 * The request's parameters, parsed from the raw bytes.
 *
 * Not `req.body`: the Functions framework parses form bodies with `qs` in
 * extended mode, where `code[a]=1` becomes an object and a repeated key becomes
 * an array, and the emulator and production need not agree. RFC 6749 §3.1 says
 * a parameter MUST NOT repeat, so a repeat is refused rather than resolved.
 *
 * Form-encoded is what Claude and ChatGPT send. JSON is accepted as well,
 * because some clients send it and nothing is lost by reading it.
 */
export function formBody(req: Request): Fields | "duplicate" | null {
  const type = String(req.headers["content-type"] ?? "").toLowerCase();
  if (type.startsWith("application/json")) {
    const body = jsonBody(req);
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const out: Fields = new Map();
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (typeof v === "string") out.set(k, v);
    }
    return out;
  }
  if (!type.startsWith("application/x-www-form-urlencoded")) return null;
  let raw: string | null = null;
  if (Buffer.isBuffer(req.rawBody)) raw = req.rawBody.toString("utf8");
  else if (typeof req.body === "string") raw = req.body;
  if (raw === null) return null;
  const out: Fields = new Map();
  for (const [k, v] of new URLSearchParams(raw)) {
    if (out.has(k)) return "duplicate";
    out.set(k, v);
  }
  return out;
}

/** A client_id from HTTP Basic, for the clients that send it there. The password is ignored. */
function basicClientId(req: Request): string | undefined {
  const auth = req.headers.authorization;
  const value = Array.isArray(auth) ? auth[0] : auth;
  const m = typeof value === "string" ? /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(value) : null;
  if (!m) return undefined;
  const decoded = Buffer.from(m[1], "base64").toString("utf8");
  const user = decoded.split(":")[0];
  try {
    return user ? decodeURIComponent(user) : undefined;
  } catch {
    return undefined;
  }
}

function error(res: Response, status: number, code: string, description: string): void {
  res.status(status).json({ error: code, error_description: description });
}

const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

function pkceMatches(verifier: string, challenge: string): boolean {
  const computed = createHash("sha256").update(verifier, "ascii").digest("base64url");
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface StoredCode extends CodeRecord {
  expiresAt: Timestamp;
  usedAt: Timestamp | null;
  tokenId: string | null;
  nonce: string | null;
}

type Exchange =
  | { kind: "pair"; body: Record<string, unknown> }
  | { kind: "error"; status: number; code: string; description: string }
  | { kind: "replayed"; uid: string; tokenId: string | null };

/**
 * Spend an authorization code.
 *
 * Every check runs BEFORE the code is spent, so a wrong verifier, client or
 * redirect URI costs the attacker nothing and the legitimate client nothing
 * either. Spending and minting happen in one transaction, so a retried
 * transaction cannot mint twice.
 *
 * A second exchange of the same code is the retry case or the theft case.
 * Inside the grace window, with the right verifier and a grant that has not
 * yet rotated, it is a retry and gets the same pair. Otherwise OAuth 2.1 asks
 * that what the code produced be revoked, and it is.
 */
async function exchangeCode(db: admin.firestore.Firestore, fields: Fields, clientId: string | undefined): Promise<Exchange> {
  const code = fields.get("code");
  const verifier = fields.get("code_verifier");
  if (!code || !verifier) {
    return { kind: "error", status: 400, code: "invalid_request", description: "code and code_verifier are required" };
  }
  if (!VERIFIER.test(verifier)) {
    return { kind: "error", status: 400, code: "invalid_grant", description: "code_verifier is malformed" };
  }
  const resourceParam = fields.get("resource");
  const resource = resourceParam === undefined ? null : canonicalResource(resourceParam);
  if (resourceParam !== undefined && !resource) {
    return { kind: "error", status: 400, code: "invalid_target", description: "resource is not a valid URI" };
  }
  const redirectUri = fields.get("redirect_uri");
  const ref = db.collection("oauthCodes").doc(createHash("sha256").update(code, "utf8").digest("hex"));

  // Plaintext remains local to this request. An independent HTTP replay must
  // still revoke a built-in CLI token, while the SDK may acknowledge its own
  // already-committed token after losing the first commit response.
  let cliReceipt: ReturnType<typeof prepareToken> | null = null;
  return db.runTransaction(async (tx): Promise<Exchange> => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      return { kind: "error", status: 400, code: "invalid_grant", description: "authorization code not recognised" };
    }
    const stored = snap.data() as StoredCode;
    const mismatch = (description: string): Exchange => ({ kind: "error", status: 400, code: "invalid_grant", description });
    if (clientId !== undefined && clientId !== stored.clientId) return mismatch("the code was issued to another client");
    if (redirectUri !== undefined && redirectUri !== stored.redirectUri) return mismatch("redirect_uri does not match the authorization request");
    if (resource && resource !== stored.resource) {
      return { kind: "error", status: 400, code: "invalid_target", description: "resource does not match the authorization request" };
    }
    if (!pkceMatches(verifier, stored.codeChallenge)) return mismatch("code_verifier does not match");

    if (stored.usedAt) {
      const receipt = cliReceipt;
      if (receipt && stored.tokenId === receipt.tokenId && stored.registration === "builtin" && stored.clientId === CLI_CLIENT_ID) {
        const committed = (await tx.get(db.collection("tokens").doc(receipt.tokenId))).data();
        if (committed && committed.revokedAt == null && committed.uid === stored.uid && committed.hash === receipt.record.hash) {
          return { kind: "pair", body: { access_token: receipt.plaintext, token_type: "Bearer" } };
        }
      }
      // Possession is proven twice over by now — the code hashed to this
      // document and the verifier matched — so acting on a replay is safe.
      const since = Date.now() - stored.usedAt.toMillis();
      if (since <= REPLAY_GRACE_MS && stored.tokenId && stored.nonce && stored.registration !== "builtin") {
        const grant = await tx.get(db.collection("tokens").doc(stored.tokenId));
        const g = grant.data() as { generation?: number; revokedAt?: unknown; accessExpiresAt?: Timestamp } | undefined;
        if (g && g.revokedAt == null && (g.generation ?? 0) === 0) {
          return {
            kind: "pair",
            body: { ...replayCodePair(stored.tokenId, code, stored.nonce, g.accessExpiresAt?.toMillis() ?? 0) },
          };
        }
      }
      return { kind: "replayed", uid: stored.uid, tokenId: stored.tokenId };
    }
    if (stored.expiresAt.toMillis() <= Date.now()) return mismatch("authorization code expired");

    const now = Timestamp.fromMillis(Date.now());
    if (stored.registration === "builtin" && stored.clientId === CLI_CLIENT_ID) {
      // The command line gets an ordinary personal token. It calls endpoints
      // other than /mcp, and several of its processes may run at once, which a
      // rotating refresh token would read as theft.
      const name = stored.device ? `CLI on ${stored.device}` : "Command line";
      const prepared = prepareToken(stored.uid, stored.emailLower, name, "cli");
      tx.set(db.collection("tokens").doc(prepared.tokenId), prepared.record);
      tx.set(db.collection("users").doc(stored.uid).collection("tokens").doc(prepared.tokenId), prepared.mirror);
      tx.set(ref, { usedAt: now, tokenId: prepared.tokenId }, { merge: true });
      cliReceipt = prepared;
      return { kind: "pair", body: { access_token: prepared.plaintext, token_type: "Bearer" } };
    }

    const nonce = randomBytes(16).toString("base64url");
    const { tokenId, pair } = createGrant(db, tx, code, stored, nonce);
    tx.set(ref, { usedAt: now, tokenId, nonce }, { merge: true });
    return { kind: "pair", body: { ...pair } };
  });
}

export async function handleToken(req: Request, res: Response): Promise<void> {
  if (rejectMethod(req, res, ["POST"])) return;
  // RFC 6749 §5.1. Cache-Control is already `private, no-store`, set on entry.
  res.setHeader("Pragma", "no-cache");

  const fields = formBody(req);
  if (fields === "duplicate") {
    error(res, 400, "invalid_request", "a parameter was repeated");
    return;
  }
  if (!fields) {
    error(res, 400, "invalid_request", "send the parameters form-encoded");
    return;
  }
  const clientId = fields.get("client_id") ?? basicClientId(req);
  const db = admin.firestore();

  try {
    const grantType = fields.get("grant_type");
    if (grantType === "authorization_code") {
      const result = await exchangeCode(db, fields, clientId);
      if (result.kind === "replayed") {
        if (result.tokenId) await revokeToken(db, result.uid, result.tokenId);
        error(res, 400, "invalid_grant", "authorization code was already used; what it issued has been revoked");
        return;
      }
      if (result.kind === "error") {
        error(res, result.status, result.code, result.description);
        return;
      }
      res.status(200).json(result.body);
      return;
    }

    if (grantType === "refresh_token") {
      const presented = fields.get("refresh_token");
      if (!presented) {
        error(res, 400, "invalid_request", "refresh_token is required");
        return;
      }
      const resourceParam = fields.get("resource");
      const resource = resourceParam === undefined ? null : canonicalResource(resourceParam);
      if (resourceParam !== undefined && !resource) {
        error(res, 400, "invalid_target", "resource is not a valid URI");
        return;
      }
      const result = await refreshGrant(db, presented, { clientId, resource });
      if (!result.ok) {
        error(res, result.status, result.error, result.description);
        return;
      }
      res.status(200).json(result.pair);
      return;
    }

    error(res, 400, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
  } catch (err) {
    // Never `invalid_grant` for a failure of ours: a client told that throws
    // the connection away.
    console.error("token endpoint failed:", (err as Error)?.message ?? err);
    error(res, 500, "server_error", "try again");
  }
}
