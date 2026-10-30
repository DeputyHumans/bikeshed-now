// SPDX-License-Identifier: Apache-2.0
// Deleting from the Trash forever: whether it is possible here, the emailed code, and what goes (SPEC §4).

import { get, post } from "./api";
import type { OrganizeKind } from "./folders";

/** One item, or everything in the Trash: what a code is for. */
export type PurgeTarget = { all: true } | { kind: "document" | "folder"; id: string };

/** What a purge will take, as the server counts it before sending the code. */
export type PurgeSummary =
  | { kind: "document"; title: string; versions: number }
  | { kind: "folder"; title: string; documents: number; folders: number; theirs: number }
  | { kind: "all"; documents: number; folders: number };

export interface PurgeAvailability {
  /** Only where email is on: the code has to arrive. */
  available: boolean;
  /** How long the Trash keeps something before deleting it itself. */
  retentionDays: number;
}

/** What a page assumes until the server says: the Trash empties itself, and nothing more. */
export const UNKNOWN_AVAILABILITY: PurgeAvailability = { available: false, retentionDays: 30 };

export function purgeAvailability(): Promise<PurgeAvailability> {
  return get<PurgeAvailability>("/purge", {});
}

export function targetFor(kind: OrganizeKind, id: string): PurgeTarget {
  return { kind: kind === "folder" ? "folder" : "document", id };
}

export function requestPurgeCode(target: PurgeTarget): Promise<{ sentTo: string; expiresInMinutes: number; summary: PurgeSummary }> {
  return post("/purge", { op: "code", target });
}

export function confirmPurge(target: PurgeTarget, code: string): Promise<{ documents: number; folders: number }> {
  return post("/purge", { op: "confirm", target, code });
}

const count = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

/** What goes, as the dialog says it before the code is sent. */
export function purgeSentence(s: PurgeSummary): string {
  if (s.kind === "document") {
    return s.versions > 1
      ? `“${s.title}” and all ${s.versions} of its versions, with their comments, will be deleted for good.`
      : `“${s.title}” will be deleted for good, with its comments.`;
  }
  if (s.kind === "folder") {
    const inside = s.documents > 0 ? ` and ${count(s.documents, "document", "documents")} of yours in it` : "";
    const theirs = s.theirs > 0 ? ` ${count(s.theirs, "document", "documents")} that other people own will stay in their Trash.` : "";
    return `The folder “${s.title}”${inside} will be deleted for good.${theirs}`;
  }
  return `Everything in your Trash, ${count(s.documents, "document", "documents")} and ${count(s.folders, "folder", "folders")}, will be deleted for good.`;
}
