// SPDX-License-Identifier: Apache-2.0
// An identity assertion from a trusted issuer (ID-JAG): its signature and its claims (SPEC §23).

import { createPublicKey, verify, type KeyObject } from "crypto";
import { idJagIssuers } from "../config";
import { checkMetadataUrl, fetchClientMetadata } from "./fetch";
import { canonicalResource, ID_JAG_TYP } from "./metadata";

/**
 * What an Identity Assertion JWT Authorization Grant is, and what is checked.
 *
 * An organisation's issuer (Claude's, for a Claude workspace) signs a short
 * JWT saying "this person, signed in with me, wants app X to reach this
 * deployment". The app presents it to /oauth/token with the RFC 7523
 * jwt-bearer grant (ADR 0026). It is a bearer credential with no client
 * secret behind it, so nothing in it is used until all of this holds:
 *
 *   iss      one of BIKESHED_ID_JAG_ISSUERS, byte for byte. Checked FIRST, so
 *            an issuer nobody configured never makes this server fetch a thing
 *   header   typ oauth-id-jag+jwt, alg ES256 and nothing else, a kid the
 *            issuer publishes, a signature that verifies
 *   aud      this authorization server's issuer, alone
 *   times    not expired, not issued in the future, and expiring no more than
 *            ten minutes ahead: a short window is what limits a leaked one
 *   client   the client_id the request names, if it names one
 *   tenant   none: a deployment is one workspace, so an assertion addressed
 *            to a tenant was set up for something else
 *   cnf      none: a proof-of-possession key this server cannot check is
 *            refused rather than ignored
 *
 * Who the address belongs to, and whether they may connect, is decided in
 * managed.ts by the same gate as every other sign-in. The assertion only says
 * who the issuer vouches for.
 */

/** Room for a JWT with a few claims; anything larger is not one of these. */
export const MAX_ASSERTION_CHARS = 8 * 1024;
/** How far ahead an assertion may expire. */
export const MAX_AHEAD_MS = 10 * 60 * 1000;
/** Clock disagreement tolerated in either direction. */
export const SKEW_MS = 60 * 1000;
/** How long an issuer's keys are kept before they are fetched again. */
export const KEYS_TTL_MS = 60 * 60 * 1000;
/** An unknown kid refetches the keys, but no more often than this. */
export const REFETCH_GAP_MS = 60 * 1000;
/** After a failed fetch, requests fail at once for this long instead of fetching again. */
export const FAILURE_GAP_MS = 10 * 1000;
const MAX_KEYS = 20;

export interface Assertion {
  issuer: string;
  /** The issuer's own id for the person. Pinned on first use (managed.ts). */
  subject: string;
  /** Lowercased, as every address here is (SPEC §1). */
  email: string;
  clientId: string;
  jti: string;
  issuedAtMs: number;
  expiresAtMs: number;
  /** The canonical resource it names, or null if it names none. */
  resource: string | null;
}

export type AssertionCheck =
  | { ok: true; assertion: Assertion }
  | { ok: false; error: "invalid_grant"; description: string };

export interface AssertionDeps {
  fetchMetadata?: (url: URL) => Promise<unknown>;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function decodeSegment(segment: string): Record<string, unknown> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  try {
    const value = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

/** `typ` is a media type: case-insensitive, and `application/` may be left off (RFC 7515 §4.1.9). */
function isIdJagType(typ: unknown): boolean {
  if (typeof typ !== "string") return false;
  return typ.toLowerCase().replace(/^application\//, "") === ID_JAG_TYP;
}

const keyCache = new Map<string, { keys: Map<string, KeyObject>; fetchedAt: number }>();
const inflight = new Map<string, Promise<Map<string, KeyObject>>>();
const failedAt = new Map<string, number>();

/** Forget every issuer's keys. Tests only. */
export function clearIssuerKeyCache(): void {
  keyCache.clear();
  inflight.clear();
  failedAt.clear();
}

/**
 * An issuer's signing keys, by kid, from its OpenID discovery document.
 *
 * The URLs come from configuration, not from the caller, but they go through
 * the same SSRF-guarded fetch as a client's metadata anyway: one outbound path
 * is easier to keep honest than two. Only P-256 keys for signing are kept.
 */
async function fetchIssuerKeys(issuer: string, deps: AssertionDeps): Promise<Map<string, KeyObject>> {
  const fetchJson = deps.fetchMetadata ?? ((u: URL) => fetchClientMetadata(u));
  const discovery = checkMetadataUrl(`${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`);
  if (!discovery) throw new Error("the issuer's discovery URL cannot be fetched safely");
  const doc = await fetchJson(discovery);
  if (!isObject(doc) || doc.issuer !== issuer) throw new Error("the issuer's discovery document names another issuer");
  const jwksUrl = checkMetadataUrl(doc.jwks_uri);
  if (!jwksUrl) throw new Error("the issuer's jwks_uri cannot be fetched safely");
  const jwks = await fetchJson(jwksUrl);
  const keys = new Map<string, KeyObject>();
  const list = isObject(jwks) && Array.isArray(jwks.keys) ? jwks.keys.slice(0, MAX_KEYS) : [];
  for (const jwk of list) {
    if (!isObject(jwk) || jwk.kty !== "EC" || jwk.crv !== "P-256") continue;
    if (typeof jwk.kid !== "string" || typeof jwk.x !== "string" || typeof jwk.y !== "string") continue;
    if (jwk.alg !== undefined && jwk.alg !== "ES256") continue;
    if (jwk.use !== undefined && jwk.use !== "sig") continue;
    try {
      keys.set(jwk.kid, createPublicKey({ key: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, format: "jwk" }));
    } catch {
      /* not a point on the curve: skip it */
    }
  }
  return keys;
}

/**
 * The key for this kid, fetching when the cache is stale or lacks it.
 *
 * Anyone can name a trusted issuer and an unknown kid without a valid
 * signature, so what that costs is bounded: requests waiting on the same
 * issuer share one fetch, an unknown kid buys at most one fetch a minute, and
 * a failed fetch makes the next ten seconds fail at once rather than fetch.
 *
 * A failure throws, and the token endpoint answers 500: the issuer being
 * unreachable is not the assertion's fault, and saying `invalid_grant` would
 * tell the client its credential is bad.
 */
async function keyFor(issuer: string, kid: string, deps: AssertionDeps): Promise<KeyObject | null> {
  const now = Date.now();
  const hit = keyCache.get(issuer);
  if (hit && now - hit.fetchedAt < KEYS_TTL_MS && hit.keys.has(kid)) return hit.keys.get(kid) ?? null;
  if (hit && now - hit.fetchedAt < REFETCH_GAP_MS) return hit.keys.get(kid) ?? null;
  const failed = failedAt.get(issuer);
  if (failed !== undefined && now - failed < FAILURE_GAP_MS) throw new Error("the issuer's keys could not be fetched just now");
  let pending = inflight.get(issuer);
  if (!pending) {
    pending = fetchIssuerKeys(issuer, deps)
      .then(
        (keys) => {
          keyCache.set(issuer, { keys, fetchedAt: Date.now() });
          failedAt.delete(issuer);
          return keys;
        },
        (err: unknown) => {
          failedAt.set(issuer, Date.now());
          throw err;
        },
      )
      .finally(() => inflight.delete(issuer));
    inflight.set(issuer, pending);
  }
  const keys = await pending;
  return keys.get(kid) ?? null;
}

const seconds = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v * 1000 : null);

/**
 * Check an assertion presented to the token endpoint.
 *
 * `expectedAudience` is this authorization server's issuer. `clientId` is the
 * one the request named, if it named one.
 */
export async function checkAssertion(
  raw: string | undefined,
  ctx: { expectedAudience: string; clientId: string | undefined },
  deps: AssertionDeps = {},
): Promise<AssertionCheck> {
  const refuse = (description: string): AssertionCheck => ({ ok: false, error: "invalid_grant", description });
  if (!raw || raw.length > MAX_ASSERTION_CHARS) return refuse("assertion is missing or too large");
  const parts = raw.split(".");
  if (parts.length !== 3) return refuse("assertion is not a signed JWT");
  const header = decodeSegment(parts[0]);
  const claims = decodeSegment(parts[1]);
  if (!header || !claims) return refuse("assertion is not a signed JWT");

  const issuer = claims.iss;
  if (typeof issuer !== "string" || !idJagIssuers().includes(issuer)) {
    return refuse("this deployment does not trust the assertion's issuer");
  }
  if (!isIdJagType(header.typ)) return refuse(`assertion type must be ${ID_JAG_TYP}`);
  if (header.alg !== "ES256") return refuse("assertion must be signed with ES256");
  if (header.crit !== undefined) return refuse("assertion has critical headers this server does not understand");
  if (typeof header.kid !== "string" || header.kid.length === 0) return refuse("assertion names no key");

  const key = await keyFor(issuer, header.kid, deps);
  if (!key) return refuse("assertion is signed with a key its issuer does not publish");
  const signature = /^[A-Za-z0-9_-]+$/.test(parts[2]) ? Buffer.from(parts[2], "base64url") : Buffer.alloc(0);
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`, "ascii");
  if (signature.length !== 64 || !verify("sha256", signed, { key, dsaEncoding: "ieee-p1363" }, signature)) {
    return refuse("assertion signature does not verify");
  }

  // Signed by an issuer this deployment trusts. From here a refusal is logged
  // with the claim NAMES and the lifetime, never their values: that is what a
  // first live exchange needs to show if a limit here is wrong.
  const exp = seconds(claims.exp);
  const iat = seconds(claims.iat);
  const refuseSigned = (description: string): AssertionCheck => {
    console.warn("id-jag refused:", description, {
      claims: Object.keys(claims).sort().join(" "),
      lifetimeS: exp !== null && iat !== null ? Math.round((exp - iat) / 1000) : null,
    });
    return refuse(description);
  };

  const aud = claims.aud;
  const audience = Array.isArray(aud) && aud.length === 1 ? aud[0] : aud;
  if (audience !== ctx.expectedAudience) return refuseSigned("assertion is addressed to another server");
  const now = Date.now();
  if (exp === null || iat === null) return refuseSigned("assertion must carry exp and iat");
  if (exp <= now - SKEW_MS) return refuseSigned("assertion has expired");
  if (exp > now + MAX_AHEAD_MS + SKEW_MS) return refuseSigned("assertion expires too far ahead");
  if (iat > now + SKEW_MS) return refuseSigned("assertion was issued in the future");
  const nbf = seconds(claims.nbf);
  if (claims.nbf !== undefined && (nbf === null || nbf > now + SKEW_MS)) return refuseSigned("assertion is not valid yet");

  const subject = claims.sub;
  if (typeof subject !== "string" || subject.length === 0 || subject.length > 256) {
    return refuseSigned("assertion names no subject");
  }
  const jti = claims.jti;
  if (typeof jti !== "string" || jti.length === 0 || jti.length > 256) return refuseSigned("assertion has no jti");
  const clientId = claims.client_id;
  if (typeof clientId !== "string" || clientId.length === 0) return refuseSigned("assertion names no client");
  if (ctx.clientId !== undefined && ctx.clientId !== clientId) {
    return refuseSigned("assertion was issued to another client");
  }
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  if (!email || email.length > 320 || !email.includes("@")) return refuseSigned("assertion carries no email address");
  if (claims.aud_tenant !== undefined && claims.aud_tenant !== null && claims.aud_tenant !== "") {
    return refuseSigned("this deployment has no tenants; leave the tenant ID empty");
  }
  if (claims.cnf !== undefined) return refuseSigned("proof-of-possession assertions are not supported");

  let resource: string | null = null;
  if (claims.resource !== undefined) {
    const named = Array.isArray(claims.resource) && claims.resource.length === 1 ? claims.resource[0] : claims.resource;
    resource = canonicalResource(named);
    if (!resource) return refuseSigned("assertion's resource is not a single URI");
  }

  return {
    ok: true,
    assertion: { issuer, subject, email, clientId, jti, issuedAtMs: iat, expiresAtMs: exp, resource },
  };
}
