// SPDX-License-Identifier: Apache-2.0
// The four roles and what a record says each person may do (SPEC §13).

import type { Role } from "./types";

/**
 * Lowest first, each able to do everything below it. The server owns the
 * decision; this is what the interface reads to decide what to OFFER, so it
 * must agree with `functions/src/lib/acl.ts` or a button appears that the
 * server then refuses.
 */
export const ROLES: readonly Role[] = ["viewer", "suggester", "editor", "approver"];

/** The field each role's direct grants are stored in. */
export const GRANT_LIST = {
  viewer: "viewers",
  suggester: "suggesters",
  editor: "editors",
  approver: "approvers",
} as const satisfies Record<Role, string>;

export type RoleGrants = Record<(typeof GRANT_LIST)[Role], string[]>;

/** What the share dialog calls each role, and the one line that says what it adds. */
export const ROLE_LABEL: Record<Role, string> = {
  viewer: "Can read",
  suggester: "Can suggest",
  editor: "Can edit",
  approver: "Can approve",
};

export const ROLE_HINT: Record<Role, string> = {
  viewer: "Reads it and comments.",
  suggester: "Comments, and suggests edits for an approver to accept or reject.",
  editor: "Edits it directly and publishes new versions.",
  approver: "Edits it, and accepts or rejects what other people suggest.",
};

/** The direct grants on a document or folder record. A list it lacks is empty. */
export function grantsOf(record: object | null | undefined): RoleGrants {
  const fields = (record ?? {}) as Record<string, unknown>;
  const out = {} as RoleGrants;
  for (const role of ROLES) {
    const list = fields[GRANT_LIST[role]];
    out[GRANT_LIST[role]] = Array.isArray(list) ? list.filter((x) => typeof x === "string") : [];
  }
  return out;
}

/** The access fields of a document record that the checks below read. */
export interface RoleRecord {
  ownerEmail?: string;
  editors?: string[];
  approvers?: string[];
  editorMembers?: string[];
  suggesters?: string[];
  suggesterMembers?: string[];
  approverMembers?: string[];
}

const has = (list: string[] | undefined, emailLower: string) =>
  Boolean(emailLower && list?.includes(emailLower));

/**
 * The real editor set, mirroring `isDocEditor` in acl.ts: the owner, direct
 * editors and approvers, and everyone the server expanded into editorMembers.
 * An approver edits, because accepting a suggestion is an edit.
 */
export function isDocEditor(record: RoleRecord | null | undefined, emailLower: string): boolean {
  if (!record || !emailLower) return false;
  return (
    record.ownerEmail === emailLower ||
    has(record.editors, emailLower) ||
    has(record.approvers, emailLower) ||
    has(record.editorMembers, emailLower)
  );
}
