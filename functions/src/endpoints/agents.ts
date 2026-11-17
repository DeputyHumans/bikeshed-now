// SPDX-License-Identifier: Apache-2.0
// The agent surface: MCP and OAuth, each loaded on its first request (SPEC §19, §23).

import { onRequest } from "firebase-functions/v2/https";
import { noStore } from "../lib/http";
import { MAILING, PLAIN } from "./runtime";

// ---------------------------------------------------------------------------
// Agent surface
// ---------------------------------------------------------------------------

/**
 * POST /mcp — the Model Context Protocol endpoint (SPEC §19).
 *
 * `cors: true` because a browser-hosted MCP client is a real deployment shape;
 * the credential is a Bearer token, never the session cookie, so there is no
 * cross-site request forgery surface to widen by allowing it.
 */
export const mcp = onRequest({ ...MAILING, cors: true }, async (req, res) => {
  // Before anything can answer: a GET's 405 and every 401 would otherwise
  // inherit Hosting's default max-age=600.
  noStore(res);
  const { handleMcp } = await import("../mcp/server");
  await handleMcp(req, res);
});

/**
 * Discovery, registration and the token endpoint for apps that connect by
 * signing in (SPEC §23).
 *
 * `cors: true` for the same reason as /mcp: none of it reads a cookie, and a
 * browser-hosted client is a real deployment shape.
 */
export const oauth = onRequest({ ...PLAIN, cors: true }, async (req, res) => {
  noStore(res);
  const { handleOauth } = await import("../oauth/routes");
  await handleOauth(req, res);
});

/**
 * POST /oauth/consent — the person's decision about an app (SPEC §23).
 *
 * No CORS, deliberately: only the consent page on this origin may ask, and it
 * authenticates with the signed-in account's ID token rather than the cookie.
 */
export const oauthConsent = onRequest(PLAIN, async (req, res) => {
  noStore(res);
  const { handleConsent } = await import("../oauth/consent");
  await handleConsent(req, res);
});
