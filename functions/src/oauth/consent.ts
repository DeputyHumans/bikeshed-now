// SPDX-License-Identifier: Apache-2.0
// POST /oauth/consent: describe a request to connect, and record the person's decision (SPEC §23).

import { createHash, randomBytes } from "crypto";
import * as admin from "firebase-admin";
import { Timestamp } from "firebase-admin/firestore";
import type { Request } from "firebase-functions/v2/https";
import type { Response } from "express";
import { isEmulated } from "../config";
import { verifyIdToken, type Principal } from "../lib/auth";
import { jsonBody, rejectMethod } from "../lib/http";
import { bearerFrom } from "../lib/tokens";
import { cleanClientName, resolveClient, type ClientInfo, type ResolveDeps } from "./clients";
import { allowedHosts, allowedResources, canonicalResource, issuer, resourceFor } from "./metadata";
import {
  authorizationResponse,
  parseRedirectUri,
  redirectHost,
  redirectMatches,
  type ParsedRedirect,
} from "./redirect";

/** The only authorize parameters this server reads. Anything else is dropped. */
export const AUTHORIZE_PARAMS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "state",
  "resource",
  "scope",
  "device",
] as const;
type Params = Partial<Record<(typeof AUTHORIZE_PARAMS)[number], string>>;

export const CODE_TTL_MS = 2 * 60 * 1000;

/** An authorization request that has passed every check. */
export interface CheckedRequest {
  client: ClientInfo;
  redirect: ParsedRedirect;
  codeChallenge: string;
  state: string | null;
  resource: string;
  device: string | null;
}

/**
 * Why a request failed, and whether it is safe to say so to the client.
 *
 * Until the client and its redirect URI are both established, nothing may be
 * sent anywhere: the redirect URI is exactly what an attacker would supply. So
 * those failures carry no `back`, and the page shows them to the person. After
 * that, the failure goes back to the client — but only when the person presses
 * the button, never by itself (RFC 9700 §4.11).
 */
export type CheckFailure = { valid: false; error: string; message: string; back?: string };

function pickParams(raw: unknown): Params {
  const out: Params = {};
  if (!raw || typeof raw !== "object") return out;
  for (const key of AUTHORIZE_PARAMS) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === "string" && value.length <= 4096) out[key] = value;
  }
  return out;
}

const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

/** Check an authorization request, end to end, before anything is shown or minted. */
export async function checkAuthorizeRequest(
  params: Params,
  req: Request,
  deps: ResolveDeps = {},
): Promise<CheckedRequest | CheckFailure> {
  if (!params.client_id) {
    return { valid: false, error: "invalid_request", message: "The app didn't say who it is, so there's nothing to approve." };
  }
  const client = await resolveClient(params.client_id, deps);
  if (!client) {
    return { valid: false, error: "invalid_client", message: "We couldn't confirm which app is asking. Try connecting again from the app." };
  }
  const redirect = parseRedirectUri(params.redirect_uri);
  if (!redirect || !client.redirectUris.some((r) => redirectMatches(r, redirect.raw))) {
    return {
      valid: false,
      error: "invalid_redirect_uri",
      message: "This app asked to send you back to an address it never registered, so we stopped here.",
    };
  }

  const iss = issuer(req);
  const state = params.state ?? null;
  const fail = (error: string, message: string, description: string): CheckFailure => ({
    valid: false,
    error,
    message,
    back: authorizationResponse(redirect.raw, { error, error_description: description, state, iss }),
  });
  if (state !== null && state.length > 1024) {
    return fail("invalid_request", "The app's request was malformed.", "state is too long");
  }
  if (params.response_type !== "code") {
    return fail("unsupported_response_type", "The app asked for a kind of sign-in this server doesn't offer.", "response_type must be code");
  }
  if (params.code_challenge_method !== "S256" || !PKCE_CHALLENGE.test(params.code_challenge ?? "")) {
    return fail("invalid_request", "The app's request was missing a security check this server requires.", "PKCE with S256 is required");
  }
  let resource = resourceFor(req);
  if (params.resource !== undefined) {
    const canonical = canonicalResource(params.resource);
    if (!canonical || !allowedResources(req).includes(canonical)) {
      return fail("invalid_target", "The app asked for access to something this server doesn't host.", "resource is not this server's MCP endpoint");
    }
    resource = canonical;
  }
  const device = client.registration === "builtin" && params.device ? cleanClientName(params.device, "").slice(0, 60) || null : null;

  return { client, redirect, codeChallenge: params.code_challenge as string, state, resource, device };
}

/**
 * Is this request from our own page?
 *
 * The credential is an ID token in a header, which a cross-site page cannot
 * read or send, so this is defence in depth rather than the defence. It still
 * matters: it is what stops a page somewhere else using a trusted document's
 * script on our origin to ask for nothing more than a description.
 */
function sameOrigin(req: Request): boolean {
  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string") return site === "same-origin";
  const origin = req.headers.origin;
  if (typeof origin !== "string") return false;
  let host: string;
  try {
    const url = new URL(origin);
    host = url.host.toLowerCase();
    if (isEmulated()) return url.hostname === "127.0.0.1" || url.hostname === "localhost";
    if (url.protocol !== "https:") return false;
  } catch {
    return false;
  }
  return allowedHosts().includes(host);
}

/**
 * The account deciding. An ID token, verified and gated — never the cookie.
 *
 * Not `resolveCaller`, which would accept a personal access token: approving a
 * new credential with an existing one is how a leaked token becomes permanent
 * access, the same rule as POST /tokens. And not the session cookie, because
 * the cookie can name a different account from the one on screen; the ID token
 * is the account the page shows, so a connection always goes to the person who
 * saw "Signed in as".
 */
async function deciding(req: Request): Promise<Principal | null> {
  const raw = req.headers.authorization;
  const token = bearerFrom(Array.isArray(raw) ? raw[0] : raw);
  if (!token) return null;
  const gate = await verifyIdToken(token);
  return gate.ok ? gate.principal : null;
}

function codeHash(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

/** Mint and store an authorization code for an approved request. */
async function mintCode(db: admin.firestore.Firestore, principal: Principal, checked: CheckedRequest): Promise<string> {
  const code = randomBytes(32).toString("base64url");
  const now = Date.now();
  await db.collection("oauthCodes").doc(codeHash(code)).set({
    uid: principal.uid,
    emailLower: principal.emailLower,
    clientId: checked.client.id,
    clientName: checked.client.name,
    clientHost: checked.client.host,
    clientVerified: checked.client.verified,
    registration: checked.client.registration,
    redirectUri: checked.redirect.raw,
    redirectHost: checked.redirect.kind === "loopback" ? null : redirectHost(checked.redirect),
    codeChallenge: checked.codeChallenge,
    resource: checked.resource,
    device: checked.device,
    createdAt: Timestamp.fromMillis(now),
    expiresAt: Timestamp.fromMillis(now + CODE_TTL_MS),
    // A Timestamp field an operator can point a Firestore TTL policy at. Nothing
    // here depends on it: expiry is checked when the code is read.
    expireAt: Timestamp.fromMillis(now + 24 * 60 * 60 * 1000),
    usedAt: null,
    tokenId: null,
    nonce: null,
  });
  return code;
}

export async function handleConsent(req: Request, res: Response, deps: ResolveDeps = {}): Promise<void> {
  if (rejectMethod(req, res, ["POST"])) return;
  if (!sameOrigin(req)) {
    res.status(403).json({ error: "This request has to come from Bikeshed's own page." });
    return;
  }
  const contentType = String(req.headers["content-type"] ?? "");
  if (!contentType.toLowerCase().startsWith("application/json")) {
    res.status(400).json({ error: "Expected a JSON body." });
    return;
  }
  const principal = await deciding(req);
  if (!principal) {
    res.status(401).json({ error: "Sign in to continue." });
    return;
  }
  const body = jsonBody(req) as { action?: unknown; params?: unknown } | null;
  const action = body?.action;
  if (action !== "describe" && action !== "approve" && action !== "deny") {
    res.status(400).json({ error: 'action must be "describe", "approve" or "deny"' });
    return;
  }

  const checked = await checkAuthorizeRequest(pickParams(body?.params), req, deps);
  if ("valid" in checked) {
    res.status(200).json(checked);
    return;
  }
  const iss = issuer(req);

  if (action === "describe") {
    res.status(200).json({
      valid: true,
      client: {
        name: checked.client.name,
        host: checked.client.host,
        verified: checked.client.verified,
        registration: checked.client.registration,
      },
      redirect: {
        host: redirectHost(checked.redirect),
        kind: checked.redirect.kind,
        scheme: checked.redirect.url.protocol.replace(/:$/, ""),
      },
      account: { email: principal.emailLower },
      device: checked.device,
    });
    return;
  }

  if (action === "deny") {
    res.status(200).json({
      redirect: authorizationResponse(checked.redirect.raw, { error: "access_denied", state: checked.state, iss }),
    });
    return;
  }

  const code = await mintCode(admin.firestore(), principal, checked);
  res.status(200).json({
    redirect: authorizationResponse(checked.redirect.raw, { code, state: checked.state, iss }),
  });
}
