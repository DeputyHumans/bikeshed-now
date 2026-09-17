// SPDX-License-Identifier: Apache-2.0
// Who did this, through what, and which of that is trustworthy (SPEC §17).

import * as admin from "firebase-admin";
import type { Request } from "firebase-functions/v2/https";
import * as cookie from "cookie";
import { SESSION_COOKIE_NAME } from "../config";
import { verifySessionCookie, type Principal } from "./auth";
import { bearerFrom, isTokenShaped, verifyToken } from "./tokens";

/**
 * The provenance stamp.
 *
 * The split between trustworthy and self-reported is the whole design, and it is
 * stated rather than blurred:
 *
 *   uid, email, channel, tokenId   SERVER-DERIVED from the credential actually
 *                                  presented. A Bearer token cannot claim to be
 *                                  `web`; the /mcp endpoint stamps `mcp`
 *                                  whatever the caller says; and on the direct
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
   * They are still identified — `channel: "cli"` with an `email` from the
   * required `--account` flag and no `tokenId` — and that combination is
   * exactly what distinguishes an operator action from a user's CLI token.
   */
  uid: string | null;
  email: string;
  channel: "web" | "cli" | "mcp" | "api";
  tokenId?: string;
  client?: string;
  agent?: string;
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

/**
 * Build the stamp for a request.
 *
 * `channelOverride` exists for the MCP endpoint, which knows more about the
 * channel than the credential does.
 */
export function actorFrom(
  principal: Principal,
  req: Request,
  channelOverride?: Actor["channel"],
): Actor {
  const actor: Actor = {
    uid: principal.uid,
    email: principal.emailLower,
    channel: channelOverride ?? principal.channel,
  };
  if (principal.tokenId) actor.tokenId = principal.tokenId;
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
      };
    }
  }

  return null;
}
