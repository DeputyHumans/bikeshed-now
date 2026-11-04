// SPDX-License-Identifier: Apache-2.0
// A connection an organisation's issuer makes for one person: exchange, retry, opt-out (SPEC §23).

import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import * as admin from "firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import type { Request } from "firebase-functions/v2/https";
import { checkAssertion, SKEW_MS, type AssertionDeps } from "./assertion";
import { resolveClient } from "./clients";
import { checkMetadataUrl } from "./fetch";
import { ACCESS_PREFIX, ACCESS_TTL_MS, REPLAY_GRACE_MS, gateStillOpen, sha256 } from "./grants";
import { allowedResources, canonicalResource, issuer, resourceFor } from "./metadata";

/**
 * A managed connection is ONE row in `tokens/` per (issuer, person, address,
 * client).
 *
 * The id is derived from those four, so every assertion for the same person,
 * address and app lands on the same row, and a different app or a moved
 * address (SPEC §14) gets a row of its own. The row is `kind: "oauth"`, so
 * /mcp verifies its tokens, the account screen lists it and Revoke ends it,
 * all with no new code. What makes it different:
 *
 *   one token per assertion
 *                each exchange mints an access token of an hour, and the row
 *                keeps the HASHES of the live ones, each valid until its own
 *                expiry, so two exchanges at once never cut each other off
 *   no refresh   the draft says not to issue one, and the row has no refresh
 *                hash, so a refresh token for it cannot exist
 *   not derivable from the store
 *                a token is HMAC(row nonce, the assertion). The assertion is
 *                never stored, so reading the row yields no token, unlike a
 *                counter or a timestamp would
 *   retry        the same assertion presented again within REPLAY_GRACE_MS is
 *                answered with the same token, re-derived, as a timed-out
 *                code exchange is. After that it is spent
 *   sticky       a revoked row refuses every later assertion from that issuer
 *                for that person and address, whichever app it names: the
 *                person said no, and the organisation does not get to say yes
 *                again, not even by naming another client. They can still
 *                connect an app themselves, through consent
 *   pinned sub   the issuer's id for the person is fixed at the first
 *                exchange. A different one later, through any app, means the
 *                address now belongs to someone else there, and that is
 *                refused
 */

/** Live tokens kept per row: well over an hour's worth of ordinary use. */
export const MAX_LIVE = 100;

type Failure = {
  status: 400 | 500;
  body: { error: string; error_description: string };
};
export type AssertionGrantResult =
  | { status: 200; body: { access_token: string; token_type: "Bearer"; expires_in: number } }
  | Failure;

const fail = (status: 400 | 500, error: string, description: string): Failure => ({
  status,
  body: { error, error_description: description },
});

/** The row a person's managed connection lives in. */
export function managedTokenId(issuerId: string, uid: string, email: string, clientId: string): string {
  return sha256(`managed\n${issuerId}\n${uid}\n${email}\n${clientId}`).slice(0, 32);
}

/** The access secret for one assertion: needs the row's nonce AND the assertion. */
function accessSecret(nonce: string, assertion: string): string {
  return createHmac("sha256", nonce).update(`managed-access\n${assertion}`, "utf8").digest("base64url");
}

function sameHash(expectedHex: string, value: string): boolean {
  const a = Buffer.from(expectedHex, "hex");
  const b = Buffer.from(sha256(value), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** One live access token: its hash, its expiry, and the assertion that made it. */
interface LiveToken {
  /** sha256 of the access secret. */
  h: string;
  /** When the access token expires, ms. */
  exp: number;
  /** sha256 of the assertion's issuer and jti. */
  j: string;
  /** When the assertion itself expires, ms. */
  ax: number;
  /** When it was spent, ms. */
  at: number;
}

const isLive = (e: unknown): e is LiveToken => {
  const x = e as Partial<LiveToken> | null;
  return (
    !!x &&
    typeof x.h === "string" &&
    x.h.length === 64 &&
    typeof x.exp === "number" &&
    typeof x.j === "string" &&
    typeof x.ax === "number" &&
    typeof x.at === "number"
  );
};

interface ManagedRow {
  kind?: string;
  uid?: string;
  managed?: { issuer?: string; subject?: string };
  nonce?: string;
  liveAccess?: unknown[];
  revokedAt?: unknown;
}

/**
 * Spend an identity assertion presented with the jwt-bearer grant.
 *
 * `clientIdParam` is the client_id the request named, if any. A failure of
 * ours (Auth, the issuer or the client's metadata unreachable) is a 500,
 * never `invalid_grant` or `invalid_client`.
 */
export async function exchangeAssertion(
  req: Request,
  fields: Map<string, string>,
  clientIdParam: string | undefined,
  deps: AssertionDeps = {},
): Promise<AssertionGrantResult> {
  const raw = fields.get("assertion");
  const checked = await checkAssertion(raw, { expectedAudience: issuer(req), clientId: clientIdParam }, deps);
  if (!checked.ok) return fail(400, checked.error, checked.description);
  const a = checked.assertion;
  const assertion = raw as string;

  // The resource: the assertion's, else the request's, else this host's /mcp.
  const allowed = allowedResources(req);
  if (a.resource && !allowed.includes(a.resource)) {
    return fail(400, "invalid_grant", "the assertion is for another server");
  }
  const param = fields.get("resource");
  const requested = param === undefined ? null : canonicalResource(param);
  if (param !== undefined && (!requested || !allowed.includes(requested))) {
    return fail(400, "invalid_target", "resource is not this server's MCP endpoint");
  }
  if (a.resource && requested && requested !== a.resource) {
    return fail(400, "invalid_target", "resource does not match the assertion");
  }
  const resource = a.resource ?? requested ?? resourceFor(req);

  // Only a client that publishes its own metadata: the account screen then
  // shows a host that was checked, not a name the client chose. A metadata
  // URL that would not resolve just now is our blip, not a bad client.
  const client = await resolveClient(a.clientId, { fetchMetadata: deps.fetchMetadata });
  if (!client) {
    const url = checkMetadataUrl(a.clientId);
    if (url && url.href === a.clientId) return fail(500, "server_error", "the client's metadata could not be read; try again");
    return fail(400, "invalid_client", "the assertion's client does not publish a metadata document");
  }
  if (client.registration !== "cimd") {
    return fail(400, "invalid_client", "the assertion's client does not publish a metadata document");
  }

  // The address must already be someone's account here. An assertion never
  // creates one: that would be a second way in, beside sign-up (ADR 0014).
  let uid: string;
  try {
    uid = (await admin.auth().getUserByEmail(a.email)).uid;
  } catch (err) {
    if ((err as { code?: string })?.code === "auth/user-not-found") {
      return fail(400, "access_denied", "no account here uses this address; sign in to Bikeshed once to create it");
    }
    console.error("id-jag account lookup failed:", (err as Error)?.message ?? err);
    return fail(500, "server_error", "try again");
  }

  // The same gate as every sign-in: verified, enabled, the same address,
  // allowed. Each assertion is a fresh sign-in by the issuer, so it is judged
  // as one: "signed out everywhere" ends the tokens issued before it, within
  // their hour, and does not bar what the organisation signs afterwards.
  const gate = await gateStillOpen(uid, a.email, Date.now());
  if (gate === "unknown") return fail(500, "server_error", "try again");
  if (gate === "closed") return fail(400, "access_denied", "this account cannot be connected");

  const db = admin.firestore();
  const tokenId = managedTokenId(a.issuer, uid, a.email, client.id);
  const ref = db.collection("tokens").doc(tokenId);
  const mirrorRef = db.collection("users").doc(uid).collection("tokens").doc(tokenId);
  const jtiHash = sha256(`${a.issuer}\n${a.jti}`);
  // Every connection this issuer made for this person at this address, any
  // app's. The address is in the scope on purpose: an account move (SPEC §14)
  // revokes the rows under the old address, and the new one starts fresh
  // rather than inheriting that as the person's own "no".
  const siblings = db.collection("tokens")
    .where("uid", "==", uid)
    .where("managed.issuer", "==", a.issuer)
    .where("email", "==", a.email);

  const result = await db.runTransaction(async (tx): Promise<AssertionGrantResult & { retried?: boolean }> => {
    const snap = await tx.get(ref);
    const row = snap.exists ? (snap.data() as ManagedRow) : null;
    // Until 0.32.0 the veto and the pin were this row's alone, and the row is
    // keyed by the app: an assertion naming another client_id got a fresh row,
    // neither revoked nor pinned (ADR 0026).
    for (const other of (await tx.get(siblings)).docs.map((d) => d.data() as ManagedRow)) {
      if (other.kind !== "oauth") continue;
      if (other.revokedAt != null) {
        return fail(400, "access_denied", "automatic connection was turned off for this account; connect by signing in instead");
      }
      if (typeof other.managed?.subject === "string" && other.managed.subject !== a.subject) {
        return fail(400, "access_denied", "this address belongs to a different account at the issuer now");
      }
    }
    const now = Date.now();
    if (row) {
      if (row.kind !== "oauth" || row.uid !== uid || row.managed?.issuer !== a.issuer || typeof row.nonce !== "string") {
        console.error("id-jag row does not match its id:", tokenId);
        return fail(500, "server_error", "try again");
      }
      if (row.revokedAt != null) {
        return fail(400, "access_denied", "automatic connection was turned off for this account; connect by signing in instead");
      }
      if (row.managed?.subject !== a.subject) {
        return fail(400, "access_denied", "this address belongs to a different account at the issuer now");
      }
    }
    const nonce = row?.nonce ?? randomBytes(16).toString("base64url");
    const secret = accessSecret(nonce, assertion);
    const accessToken = `${ACCESS_PREFIX}${tokenId}.${secret}`;

    // An entry outlives its assertion (an hour against ten minutes), so an
    // assertion that could still be presented is always still listed.
    const live = (Array.isArray(row?.liveAccess) ? row!.liveAccess! : []).filter(isLive).filter((e) => e.exp > now);
    const seen = live.find((e) => e.j === jtiHash);
    if (seen) {
      if (now - seen.at <= REPLAY_GRACE_MS && sameHash(seen.h, secret)) {
        return {
          status: 200,
          retried: true,
          body: { access_token: accessToken, token_type: "Bearer", expires_in: Math.floor((seen.exp - now) / 1000) },
        };
      }
      return fail(400, "invalid_grant", "this assertion has already been used");
    }
    if (live.length >= MAX_LIVE) {
      // Make room only by forgetting an entry whose assertion has expired,
      // so a forgotten jti can never be presented again.
      const spare = live.findIndex((e) => e.ax <= now - SKEW_MS);
      if (spare < 0) return fail(400, "invalid_grant", "too many connections for this account just now; try again shortly");
      live.splice(spare, 1);
    }
    const accessExpiresMs = now + ACCESS_TTL_MS;
    live.push({ h: sha256(secret), exp: accessExpiresMs, j: jtiHash, ax: a.expiresAtMs, at: now });
    const expiresAt = Timestamp.fromMillis(accessExpiresMs);

    if (!row) {
      tx.set(ref, {
        tokenId,
        kind: "oauth",
        uid,
        email: a.email,
        name: client.name,
        channel: "mcp",
        client: { id: client.id, host: client.host, verified: client.verified, registration: client.registration },
        managed: { issuer: a.issuer, subject: a.subject },
        resource,
        nonce,
        liveAccess: live,
        createdAt: FieldValue.serverTimestamp(),
        createdAtMs: now,
        revokedAt: null,
      });
      tx.set(mirrorRef, {
        tokenId,
        kind: "oauth",
        name: client.name,
        channel: "mcp",
        clientHost: client.host,
        clientVerified: client.verified,
        registration: "cimd",
        // Who connected it: the account screen says so, and says that Revoke
        // stops it for good. Never the issuer's full URL, which names the org.
        managedBy: new URL(a.issuer).host,
        createdAt: FieldValue.serverTimestamp(),
        expiresAt,
        revokedAt: null,
      });
    } else {
      tx.set(ref, { name: client.name, resource, liveAccess: live }, { merge: true });
      tx.set(mirrorRef, { name: client.name, expiresAt }, { merge: true });
    }

    return {
      status: 200,
      body: { access_token: accessToken, token_type: "Bearer", expires_in: Math.floor(ACCESS_TTL_MS / 1000) },
    };
  });

  if (result.status === 200) {
    // The lifetime is what the ten-minute cap is a guess about; never the address.
    console.log("id-jag accepted:", {
      client: client.host,
      lifetimeS: Math.round((a.expiresAtMs - a.issuedAtMs) / 1000),
      retried: result.retried === true,
    });
    return { status: 200, body: result.body };
  }
  return result;
}
