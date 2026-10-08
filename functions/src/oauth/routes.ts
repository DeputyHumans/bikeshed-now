// SPDX-License-Identifier: Apache-2.0
// The oauth function's routes: discovery, registration and the token endpoint (SPEC §23).

import type { Request } from "firebase-functions/v2/https";
import type { Response } from "express";
import { jsonBody, rejectMethod } from "../lib/http";
import { registerClient } from "./clients";
import {
  AS_METADATA_PATH,
  OIDC_METADATA_PATH,
  PRM_MCP_PATH,
  PRM_PATH,
  REGISTER_PATH,
  TOKEN_PATH,
  authorizationServerMetadata,
  protectedResourceMetadata,
} from "./metadata";
import { handleToken } from "./token";

/**
 * Everything here is public and none of it reads a cookie, so any origin may
 * call it — a browser-hosted MCP client is a real deployment shape. The CORS
 * middleware reflects the caller's origin; `*` is set over it so that the one
 * cacheable response, the authorization-server metadata, cannot be cached by
 * the CDN with one site's origin and then served to another.
 *
 * `Cache-Control: private, no-store` is already set, on entry, by the wrapper
 * in index.ts. Only the authorization-server metadata overrides it: it is the
 * same on every host and for every caller. The protected-resource metadata
 * names the host it was asked on, so it must not be cached by URL.
 */
export async function handleOauth(req: Request, res: Response): Promise<void> {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const path = req.path.replace(/\/+$/, "") || "/";

  if (path === PRM_PATH || path === PRM_MCP_PATH) {
    if (rejectMethod(req, res, ["GET", "HEAD"])) return;
    res.status(200).json(protectedResourceMetadata(req));
    return;
  }
  if (path === AS_METADATA_PATH) {
    if (rejectMethod(req, res, ["GET", "HEAD"])) return;
    res.setHeader("Cache-Control", "public, max-age=300");
    res.status(200).json(authorizationServerMetadata(req));
    return;
  }
  if (path === OIDC_METADATA_PATH) {
    // Not OpenID Connect. Answered here so a client probing for it gets a
    // plain "no" rather than the app's own HTML with a 200.
    res.status(404).json({ error: "not_found", error_description: `see ${AS_METADATA_PATH}` });
    return;
  }
  if (path === REGISTER_PATH) {
    if (rejectMethod(req, res, ["POST"])) return;
    const result = registerClient(jsonBody(req));
    res.status(result.status).json(result.body);
    return;
  }
  if (path === TOKEN_PATH) {
    await handleToken(req, res);
    return;
  }
  res.status(404).json({ error: "not_found" });
}
