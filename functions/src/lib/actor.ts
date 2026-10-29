// SPDX-License-Identifier: Apache-2.0
// Who did this, through what, and which of that is trustworthy (SPEC §17).

import * as admin from "firebase-admin";
import type { Request } from "firebase-functions/v2/https";
import * as cookie from "cookie";
import { SESSION_COOKIE_NAME } from "../config";
import { verifySessionCookie, type Principal } from "./auth";
import { CLI_LOGIN_FALLBACK, CLI_LOGIN_PREFIX, bearerFrom, isTokenShaped, verifyToken } from "./tokens";

/**
 * The provenance stamp.
 *
 * The split between trustworthy and self-reported is the whole design, and it is
 * stated rather than blurred:
 *
 *   uid, email, channel, tokenId,  SERVER-DERIVED from the credential actually
 *   via                            presented, never from the endpoint it came
 *                                  through (ADR 0023). A Bearer token cannot
 *                                  claim to be `web`; a CLI token reads `cli`
 *                                  on /mcp as everywhere else; an app connected
 *                                  by signing in reads `app`. On the direct
 *                                  Firestore write path firestore.rules pins
 *                                  actor.channel == 'web' for the same reason.
 *
 *   client, agent                  SELF-REPORTED headers, stored verbatim and
 *                                  rendered in the UI as self-reported. A badge
 *                                  that implies verification it does not have is
 *                                  worse than no badge.
 */
export interface Actor {
  /**
   * The acting account.
   *
   * Null in exactly one case: the OPERATOR scripts, which authenticate with
   * Admin credentials rather than as an account, so there is no uid to record.
   * They say so: `channel: "operator"`, with an `email` from the required
   * `--account` flag and no `tokenId`.
   */
  uid: string | null;
  email: string;
  channel: "web" | "cli" | "mcp" | "api" | "app" | "operator";
  tokenId?: string;
  /**
   * The credential in words, as it was when it acted: "CLI on mbp",
   * `“Claude” (connected app)`, `personal token “deploy-bot”`. Stored, not
   * joined later, so revoking or renaming a token never rewrites who did what.
   * Absent for `web`, which needs no words.
   */
  via?: string;
  client?: string;
  agent?: string;
}

/**
 * The words for a credential, written once here and stored with the action.
 *
 * Names are the owner's own (a token) or the app's own claim (a connected
 * app), so they are quoted, and an app is always called one: a client that
 * registered as "Web" reads `“Web” (connected app)`, never as the browser.
 */
export function viaLabel(channel: Actor["channel"], name?: string): string | undefined {
  const n = sanitizeReported(name);
  switch (channel) {
    case "web":
      return undefined;
    case "cli":
      // What `bikeshed login` mints is named for the machine, and reads as one.
      if (!n || n === CLI_LOGIN_FALLBACK) return "the command line";
      return n.startsWith(CLI_LOGIN_PREFIX) ? n : `CLI token “${n}”`;
    case "mcp":
    case "api":
      return n ? `personal token “${n}”` : "a personal token";
    case "app":
      return n ? `“${n}” (connected app)` : "a connected app";
    case "operator":
      return "an operator script";
  }
}

/**
 * Self-reported values are STORED, so they are bounded and stripped of control
 * characters. A 4 KB "client name" or an embedded newline would otherwise reach
 * the activity feed and the email templates.
 */
function sanitizeReported(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = Array.from(value)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .join("")
    .trim()
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : undefined;
}

function headerValue(req: Request, name: string): string | undefined {
  const raw = req.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

/** Build the stamp for a request, from the credential it presented. */
export function actorFrom(principal: Principal, req: Request): Actor {
  const actor: Actor = {
    uid: principal.uid,
    email: principal.emailLower,
    channel: principal.channel,
  };
  if (principal.tokenId) actor.tokenId = principal.tokenId;
  const via = viaLabel(principal.channel, principal.credentialName);
  if (via) actor.via = via;
  const client = sanitizeReported(headerValue(req, "x-bikeshed-client"));
  if (client) actor.client = client;
  const agent = sanitizeReported(headerValue(req, "x-bikeshed-agent"));
  if (agent) actor.agent = agent;
  return actor;
}

/** True when this action came from automation rather than a person at a keyboard. */
export function isAutomated(actor: Actor): boolean {
  return actor.channel !== "web";
}

/**
 * Resolve the caller from whatever credential the request carries.
 *
 * Session cookie first, because it is the common case and costs no read. A
 * Bearer personal access token is the agent path; its `channel` comes from the
 * TOKEN RECORD, not from the request, which is what stops a caller labelling
 * their own traffic.
 *
 * Returns null for anonymous. Callers decide whether anonymous is acceptable —
 * for the byte endpoints on a non-private document it is; for every write it is
 * not, and that rule has no exceptions (SPEC §17).
 */
export async function resolveCaller(req: Request): Promise<Principal | null> {
  const sessionCookie = cookie.parse(req.headers.cookie || "")[
    SESSION_COOKIE_NAME
  ];
  if (sessionCookie) {
    const principal = await verifySessionCookie(sessionCookie);
    if (principal) return principal;
  }

  const bearer = bearerFrom(headerValue(req, "authorization"));
  if (isTokenShaped(bearer)) {
    const verified = await verifyToken(admin.firestore(), bearer as string);
    if (verified) {
      return {
        uid: verified.uid,
        emailLower: verified.emailLower,
        channel: verified.channel,
        tokenId: verified.tokenId,
        credentialName: verified.name,
      };
    }
  }

  return null;
}
