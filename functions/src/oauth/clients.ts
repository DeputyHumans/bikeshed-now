// SPDX-License-Identifier: Apache-2.0
// Who a client_id names: a metadata document, a stateless registration, or the CLI (SPEC §23).

import { checkMetadataUrl, fetchClientMetadata } from "./fetch";
import { parseRedirectUri, redirectHost } from "./redirect";

/**
 * How a client identified itself, which decides what the consent page may say
 * about it.
 *
 *   cimd     its client_id is an https URL serving its own metadata (Claude,
 *            ChatGPT, Claude Code). The HOST is verified — we fetched it —
 *            so "from claude.ai" is a statement we can stand behind.
 *   dcr      it registered itself, and could have called itself anything.
 *            Only the redirect host is real.
 *   builtin  this deployment's own command line.
 */
export type Registration = "cimd" | "dcr" | "builtin";

export interface ClientInfo {
  id: string;
  name: string;
  /** The verified host for cimd; null otherwise. */
  host: string | null;
  verified: boolean;
  redirectUris: string[];
  registration: Registration;
}

export const CLI_CLIENT_ID = "bikeshed-cli";
export const CLI_CLIENT_NAME = "Bikeshed command line";
/** RFC 8252 prefers literal addresses; the CLI binds 127.0.0.1 and may use [::1]. */
const CLI_REDIRECTS = ["http://127.0.0.1/callback", "http://[::1]/callback"];

const DCR_PREFIX = "bsdcr_";
const MAX_REDIRECTS = 10;
const MAX_DCR_ID = 2048;

/**
 * A name a client chose for itself, made safe to put in front of a person.
 *
 * Strips every control and FORMAT character (`\p{Cf}`), which is what the
 * self-reported actor fields do not: a right-to-left override or a zero-width
 * joiner is how "Claude" is spelt with something else hidden inside it.
 */
export function cleanClientName(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const cleaned = raw
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Zl}\p{Zp}]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned.length > 0 ? cleaned : fallback;
}

/** Keep the redirect URIs that parse; refuse a list with none, or too many. */
function validRedirects(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_REDIRECTS) return null;
  const kept = raw.filter((u): u is string => typeof u === "string" && parseRedirectUri(u) !== null);
  return kept.length > 0 ? kept : null;
}

/**
 * Validate a fetched client metadata document against the URL it came from.
 *
 * Only what is USED is checked, because the two clients that matter most do
 * not fit a strict reading: ChatGPT's declares `private_key_jwt` with a
 * non-standard list beside it, and Claude's lists a jwt-bearer grant type. A
 * client that insists on a client secret is refused, since nothing here can
 * hold one; everything else this server does not use is ignored.
 */
export function clientFromMetadata(doc: unknown, id: string, host: string): ClientInfo | null {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  const d = doc as Record<string, unknown>;
  if (d.client_id !== id) return null;
  const redirectUris = validRedirects(d.redirect_uris);
  if (!redirectUris) return null;
  if (typeof d.token_endpoint_auth_method === "string" && d.token_endpoint_auth_method.startsWith("client_secret")) {
    return null;
  }
  if (Array.isArray(d.grant_types) && !d.grant_types.includes("authorization_code")) return null;
  if (Array.isArray(d.response_types) && !d.response_types.includes("code")) return null;
  return {
    id,
    name: cleanClientName(d.client_name, host),
    host,
    verified: true,
    redirectUris,
    registration: "cimd",
  };
}

/**
 * Dynamic client registration, without storing anything.
 *
 * The client_id IS the registration: its name and redirect URIs, encoded.
 * Unsigned on purpose. Registration is open, so anyone may register any name
 * with any redirect, and a signature would only prove that this server once
 * agreed to that — which it would agree to again. What protects a person is the
 * consent page showing where they will be sent, and that is the same either
 * way. What this buys is an unauthenticated endpoint that writes nothing.
 */
export function registerClient(body: unknown): { status: number; body: Record<string, unknown> } {
  const refuse = (error: string, description: string) => ({
    status: 400,
    body: { error, error_description: description },
  });
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return refuse("invalid_client_metadata", "the registration must be a JSON object");
  }
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.redirect_uris) || b.redirect_uris.length === 0) {
    return refuse("invalid_redirect_uri", "at least one redirect_uri is required");
  }
  if (b.redirect_uris.length > MAX_REDIRECTS) {
    return refuse("invalid_redirect_uri", `at most ${MAX_REDIRECTS} redirect_uris`);
  }
  for (const uri of b.redirect_uris) {
    if (!parseRedirectUri(uri)) {
      return refuse(
        "invalid_redirect_uri",
        "each redirect_uri must be https, http on a loopback address, or an app's own scheme",
      );
    }
  }
  const redirectUris = b.redirect_uris as string[];
  const fallback = redirectHost(parseRedirectUri(redirectUris[0])!);
  const name = cleanClientName(b.client_name, fallback);
  const clientId = `${DCR_PREFIX}${Buffer.from(JSON.stringify({ n: name, r: redirectUris }), "utf8").toString("base64url")}`;
  if (clientId.length > MAX_DCR_ID) {
    return refuse("invalid_client_metadata", "the registration is too large");
  }
  return {
    status: 201,
    body: {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // Whatever was asked for: there is no secret to issue (RFC 7591 §3.2.1
      // lets the server substitute its own values).
      token_endpoint_auth_method: "none",
    },
  };
}

/**
 * Decode a registration-encoded client_id, re-validating everything in it.
 *
 * The id came back from a stranger, not from us, so nothing in it is trusted
 * because it decodes: a hand-built id carrying `javascript:` is refused here
 * exactly as it would have been at registration.
 */
function clientFromRegistration(id: string): ClientInfo | null {
  if (id.length > MAX_DCR_ID) return null;
  const encoded = id.slice(DCR_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!decoded || typeof decoded !== "object") return null;
  const { n, r } = decoded as { n?: unknown; r?: unknown };
  if (!Array.isArray(r) || r.length === 0 || r.length > MAX_REDIRECTS) return null;
  if (!r.every((u) => typeof u === "string" && parseRedirectUri(u) !== null)) return null;
  const fallback = redirectHost(parseRedirectUri(r[0])!);
  return {
    id,
    name: cleanClientName(n, fallback),
    host: null,
    verified: false,
    redirectUris: r as string[],
    registration: "dcr",
  };
}

const CACHE_MS = 5 * 60 * 1000;
const CACHE_MAX = 100;
const cache = new Map<string, { until: number; client: ClientInfo }>();

export interface ResolveDeps {
  fetchMetadata?: (url: URL) => Promise<unknown>;
}

/** Forget cached metadata documents. Tests only. */
export function clearClientCache(): void {
  cache.clear();
}

/**
 * Resolve a client_id to a client, or null if it names nothing usable.
 *
 * A metadata document is cached per instance for five minutes, which is what
 * both Claude and ChatGPT serve theirs with; a failure is never cached, so a
 * blip does not lock a client out for longer than the blip.
 */
export async function resolveClient(id: unknown, deps: ResolveDeps = {}): Promise<ClientInfo | null> {
  if (typeof id !== "string" || id.length === 0) return null;
  if (id === CLI_CLIENT_ID) {
    return {
      id,
      name: CLI_CLIENT_NAME,
      host: null,
      verified: true,
      redirectUris: CLI_REDIRECTS,
      registration: "builtin",
    };
  }
  if (id.startsWith(DCR_PREFIX)) return clientFromRegistration(id);

  const url = checkMetadataUrl(id);
  if (!url || url.href !== id) return null;
  const hit = cache.get(id);
  if (hit && hit.until > Date.now()) return hit.client;

  let doc: unknown;
  try {
    doc = await (deps.fetchMetadata ?? ((u: URL) => fetchClientMetadata(u)))(url);
  } catch (err) {
    console.warn("client metadata fetch failed:", id, (err as Error)?.message ?? err);
    return null;
  }
  const client = clientFromMetadata(doc, id, url.hostname);
  if (client) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
    cache.set(id, { until: Date.now() + CACHE_MS, client });
  }
  return client;
}
