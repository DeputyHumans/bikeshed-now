// SPDX-License-Identifier: Apache-2.0
// Version selection and the transactional boundary between current work and archives (SPEC §4, §19).

import { safeSegment } from "./http";

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
