// SPDX-License-Identifier: Apache-2.0
// Discovery: the protected-resource and authorization-server metadata (SPEC §23).

import type { Request } from "firebase-functions/v2/https";
import { idJagDomains, idJagIssuers, isEmulated, projectId, publicOrigin } from "../config";

/** The RFC 7523 grant an identity assertion is presented with (ADR 0026). */
export const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";
/** How a client learns that this server accepts identity assertions. */
export const ID_JAG_PROFILE = "urn:ietf:params:oauth:grant-profile:id-jag";
/** The `typ` an identity assertion's header must carry. */
export const ID_JAG_TYP = "oauth-id-jag+jwt";

/**
 * The grants this deployment accepts. The assertion grant only when an issuer
 * is configured: a deployment that trusts nobody should not invite assertions.
 */
export function grantTypesSupported(): string[] {
  const grants = ["authorization_code", "refresh_token"];
  // An issuer is trusted only for the domains listed beside it: issuers with
  // no domains leave the grant off, so it fails closed (ADR 0026).
  if (idJagIssuers().length > 0 && idJagDomains().length > 0) grants.push(JWT_BEARER);
  return grants;
}

export const MCP_PATH = "/mcp";
export const PRM_PATH = "/.well-known/oauth-protected-resource";
export const PRM_MCP_PATH = `${PRM_PATH}${MCP_PATH}`;
export const AS_METADATA_PATH = "/.well-known/oauth-authorization-server";
export const OIDC_METADATA_PATH = "/.well-known/openid-configuration";
export const AUTHORIZE_PATH = "/connect";
export const TOKEN_PATH = "/oauth/token";
export const REGISTER_PATH = "/oauth/register";
export const CONSENT_PATH = "/oauth/consent";

function header(req: Request, name: string): string | undefined {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" ? value.split(",")[0].trim() : undefined;
}

/**
 * The emulator's own origin, from the request. Only ever used under the
 * emulator, where there is no configured origin to trust and nothing to protect:
 * in production a request header never decides the issuer.
 */
function emulatedOrigin(req: Request): string {
  const host = header(req, "x-forwarded-host") ?? header(req, "host") ?? "127.0.0.1:5050";
  const proto = header(req, "x-forwarded-proto") === "https" ? "https" : "http";
  return `${proto}://${host.toLowerCase()}`;
}

/**
 * The issuer: one string, compared byte for byte.
 *
 * ChatGPT checks `iss` against the `authorization_servers` entry by exact string
 * match, with no normalisation of slashes, ports or case, and only then uses its
 * stable client identity. So this has no trailing slash and comes from
 * configuration rather than from whichever host the request arrived on — the
 * authorization server is the same on every host this deployment answers to.
 */
export function issuer(req: Request): string {
  return isEmulated() ? emulatedOrigin(req) : publicOrigin();
}

/**
 * The hosts this deployment answers on, which is what a person may have pasted.
 *
 * Claude requires the protected-resource `resource` to equal the URL as the
 * person typed it, and people copy whichever host is in their address bar: the
 * configured domain, or either of Firebase's two default hosts. All three are
 * computed at runtime, so no tracked file names a real one.
 */
export function allowedHosts(): string[] {
  const hosts = new Set<string>();
  const configured = publicOrigin();
  if (configured) hosts.add(new URL(configured).host.toLowerCase());
  const id = projectId();
  if (id) {
    hosts.add(`${id}.web.app`);
    hosts.add(`${id}.firebaseapp.com`);
  }
  return [...hosts];
}

/**
 * The origin of the resource this request was made to.
 *
 * `X-Forwarded-Host` is trusted only when it names one of our own hosts, so a
 * caller reaching the function directly cannot make the metadata name a host
 * of their choosing. `Host` is never read in production: behind Hosting it is
 * the function's own address, not the one the person used.
 */
export function resourceOrigin(req: Request): string {
  if (isEmulated()) return emulatedOrigin(req);
  const forwarded = header(req, "x-forwarded-host")?.toLowerCase();
  if (forwarded && allowedHosts().includes(forwarded)) return `https://${forwarded}`;
  return publicOrigin();
}

/** The MCP endpoint's address on the host this request used. */
export function resourceFor(req: Request): string {
  return `${resourceOrigin(req)}${MCP_PATH}`;
}

/** Every address a token may be bound to: the MCP endpoint on each of our hosts. */
export function allowedResources(req: Request): string[] {
  if (isEmulated()) return [`${emulatedOrigin(req)}${MCP_PATH}`];
  return allowedHosts().map((host) => `https://${host}${MCP_PATH}`);
}

/**
 * A `resource` parameter in canonical form, or null if it is not a URI at all.
 *
 * Lower-cases the scheme and host, as RFC 8707 asks a server to tolerate, and
 * drops a trailing slash, which the MCP specification treats as the same
 * resource. A query or fragment is refused: neither identifies a resource here.
 */
export function canonicalResource(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.search || url.hash || url.username || url.password) return null;
  // The URL parser already lower-cases a special scheme's protocol and host;
  // the path stays as given, because it is case-sensitive.
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}`;
}

/** The RFC 9728 document for the host this request used. */
export function protectedResourceMetadata(req: Request): Record<string, unknown> {
  const iss = issuer(req);
  return {
    resource: resourceFor(req),
    authorization_servers: [iss],
    bearer_methods_supported: ["header"],
    resource_name: "Bikeshed",
    resource_documentation: `${iss}/llms.txt`,
  };
}

/**
 * The RFC 8414 document.
 *
 * No `scopes_supported`: a token here is its owner, with exactly their access,
 * and a scope model would be the second permission model SPEC §19 rules out.
 * With nothing advertised, clients request no scope, and none is refused.
 *
 * `client_id_metadata_document_supported` and `"none"` together are what make
 * Claude use its published identity rather than registering a new client on
 * every connection; `authorization_response_iss_parameter_supported` is what
 * makes ChatGPT use its stable one.
 *
 * `authorization_grant_profiles_supported` appears only with an issuer
 * configured. It is how Claude decides to present an identity assertion
 * rather than send the person to /connect (ADR 0026).
 */
export function authorizationServerMetadata(req: Request): Record<string, unknown> {
  const iss = issuer(req);
  const grants = grantTypesSupported();
  return {
    issuer: iss,
    authorization_endpoint: `${iss}${AUTHORIZE_PATH}`,
    token_endpoint: `${iss}${TOKEN_PATH}`,
    registration_endpoint: `${iss}${REGISTER_PATH}`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: grants,
    ...(grants.includes(JWT_BEARER) ? { authorization_grant_profiles_supported: [ID_JAG_PROFILE] } : {}),
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${iss}/llms.txt`,
  };
}

/**
 * The `WWW-Authenticate` value for a refused MCP request.
 *
 * `resource_metadata` is how an OAuth-capable client learns that signing in is
 * possible at all; without it the 401 is a dead end. `invalid_token` is added
 * when a credential was presented, so a client with an expired access token
 * knows to refresh rather than to start over.
 */
export function challenge(req: Request, presented: boolean): string {
  const parts = [
    'Bearer realm="bikeshed"',
    `resource_metadata="${resourceOrigin(req)}${PRM_MCP_PATH}"`,
  ];
  if (presented) parts.push('error="invalid_token"');
  return parts.join(", ");
}
