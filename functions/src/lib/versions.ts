// SPDX-License-Identifier: Apache-2.0
// Version selection and the transactional boundary between current work and archives (SPEC §4, §19).

import { safeSegment } from "./http";
import type { Actor } from "./actor";

/**
 * How a version's content arrived, kept apart from who sent it and through
 * what (the version's `publishedBy`, SPEC §17). The two used to share one
 * field, `publishedVia`, which therefore could not say both: an agent's commit
 * of an edit read "mcp", a fork lost its channel, and `bikeshed publish`
 * read "upload".
 */
export type VersionOrigin = "upload" | "edit" | "fork";

/**
 * The single field the two replaced, still written for whoever reads it,
 * derived here so it can no longer disagree with them: the channel for
 * anything automated, else how a person did it.
 */
export function publishedViaOf(origin: VersionOrigin, actor: Pick<Actor, "channel">): string {
  if (origin === "fork") return "fork";
  if (actor.channel !== "web") return actor.channel;
  return origin === "edit" ? "editor" : "upload";
}

export type VersionConflict = { status: 409; error: string; currentVersion: string };

export function versionConflict(currentVersion: string): VersionConflict {
  return {
    status: 409,
    error: `Historical versions are read-only. Read the latest version (${currentVersion}) before making changes.`,
    currentVersion,
  };
}

/** Call inside the transaction that writes feedback or adopts a draft. */
export function currentVersionRefusal(data: Record<string, unknown> | undefined, version: string): VersionConflict | null {
  const current = String(data?.currentVersion ?? "");
  return !current || current !== version ? versionConflict(current) : null;
}

/** Missing means current; malformed or empty selections never mean current. */
export function selectedVersion(raw: unknown, current: unknown): string {
  const version = raw === undefined ? String(current ?? "") : raw;
  if (typeof version !== "string" || !safeSegment(version)) throw new Error("invalid or missing version");
  return version;
}

/** Optional guards preserve old clients while allowing callers to pin every write. */
export function mutationVersion(raw: unknown, data: Record<string, unknown>): string {
  const version = selectedVersion(raw, data.currentVersion);
  const refusal = currentVersionRefusal(data, version);
  if (refusal) throw new Error(refusal.error);
  return version;
}

export class StaleVersionError extends Error {
  readonly status = 409;
  constructor(readonly currentVersion: string) {
    super(versionConflict(currentVersion).error);
  }
}
