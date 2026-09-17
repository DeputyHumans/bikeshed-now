// SPDX-License-Identifier: Apache-2.0
// Client for personal access tokens (SPEC §19).

import { post } from "./api";
import type { TokenSummary } from "./types";

/**
 * A token carries exactly its owner's identity, and therefore exactly their
 * ACL. No service accounts, no impersonation, no second permission model: a
 * token can do what its owner can do and nothing more.
 *
 * Minting is session-only, never token-authenticated. A credential that can
 * mint credentials turns one leak into permanent access.
 */

export type TokenChannel = "cli" | "mcp" | "api";

export interface MintedToken {
  tokenId: string;
  /** Shown once. There is no second chance, by design. */
  token: string;
}

export function createToken(name: string, channel: TokenChannel): Promise<MintedToken> {
  return post("/tokens", { op: "create", name, channel });
}

export function revokeToken(tokenId: string): Promise<{ revoked: boolean }> {
  return post("/tokens", { op: "revoke", tokenId });
}

export function listTokens(): Promise<{ tokens: TokenSummary[] }> {
  return post("/tokens", { op: "list" });
}

/** A token nobody has used is the one worth revoking. */
export function isUnused(token: TokenSummary): boolean {
  return !token.lastUsedAt && !token.revokedAt;
}
