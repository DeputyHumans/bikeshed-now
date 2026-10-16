// SPDX-License-Identifier: Apache-2.0
// Version bytes are selected by their committed record and isolated from competing uploads (SPEC §2, §6a).

import { randomUUID } from "node:crypto";
import { safeRelPath, safeSegment } from "./http";

/** Every attempt owns its objects before Firestore chooses the winning version. */
export function newBundlePrefix(docId: string): string {
  if (!safeSegment(docId)) throw new Error("invalid document storage id");
  return `docs/${docId}/bundles/${randomUUID()}`;
}

/** Older records use the version path; newer records name their immutable upload. */
export function versionStoragePrefix(docId: string, versionId: string, record: { storagePrefix?: unknown }): string {
  if (!safeSegment(docId) || !safeSegment(versionId)) throw new Error("invalid version storage id");
  const prefix = record.storagePrefix ?? `docs/${docId}/${versionId}`;
  if (typeof prefix !== "string" || safeRelPath(prefix) !== prefix || !prefix.startsWith(`docs/${docId}/`)) {
    throw new Error("invalid version storage prefix");
  }
  return prefix;
}

/** Saves never share an object path, even when their base version is the same. */
export function newDraftPrefix(docId: string): string {
  if (!safeSegment(docId)) throw new Error("invalid document storage id");
  return `docs/${docId}/drafts/${randomUUID()}`;
}

/** Legacy drafts have a fixed prefix; new saves carry their own pointer. */
export function draftStoragePrefix(docId: string, draft: { storagePrefix?: unknown }): string {
  const prefix = draft.storagePrefix ?? `docs/${docId}/draft`;
  if (!safeSegment(docId) || typeof prefix !== "string" || safeRelPath(prefix) !== prefix ||
      !(prefix === `docs/${docId}/draft` || prefix.startsWith(`docs/${docId}/drafts/`))) {
    throw new Error("invalid draft storage prefix");
  }
  return prefix;
}
