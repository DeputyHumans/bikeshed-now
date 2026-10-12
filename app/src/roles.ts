// SPDX-License-Identifier: Apache-2.0
// The four roles and what a record says each person may do (SPEC §13).

import { isExpired } from "./expiry";
import type { Role } from "./types";
import type { FrameMode } from "./viewer/frameMode";

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

/**
 * Whether to offer "Upload a new version…" (SPEC §2). The server takes the
 * real editor set for an upload, not open editing — sending a whole file is a
 * re-upload in all but name — so a public document's open editors are not
 * offered it. An expired document takes no new version from anybody.
 */
export function offersVersionUpload(
  record: (RoleRecord & { expiresAt?: Parameters<typeof isExpired>[0] }) | null | undefined,
  emailLower: string,
  nowMs: number = Date.now(),
): boolean {
  return isDocEditor(record, emailLower) && !isExpired(record?.expiresAt, nowMs);
}

/**
 * May this person decide on a suggestion? The owner and approvers, direct or
 * inherited — never anyone reached through open editing or a link, mirroring
 * `isDocApprover` in acl.ts.
 */
export function isApprover(record: RoleRecord | null | undefined, emailLower: string): boolean {
  if (!record || !emailLower) return false;
  return (
    record.ownerEmail === emailLower ||
    has(record.approvers, emailLower) ||
    has(record.approverMembers, emailLower)
  );
}

/**
 * May this person propose an edit? Suggesters, and everyone who may edit —
 * including an open editor, who could have made the change outright. Mirrors
 * `canSuggest` in acl.ts; `canEdit` is the viewer's own answer to "may edit",
 * which already folds in open editing.
 */
export function canSuggestDoc(
  record: RoleRecord | null | undefined,
  emailLower: string,
  canEdit: boolean,
): boolean {
  if (canEdit) return true;
  if (!record || !emailLower) return false;
  return has(record.suggesters, emailLower) || has(record.suggesterMembers, emailLower);
}

/**
 * Whether the selection toolbar offers "Suggest edit" (SPEC §22).
 *
 * While reading, on the published head — the version a suggestion is recorded
 * against and the server takes it on — and not once the document has expired.
 * An editor reading the draft is offered it like anybody else: suggesting is
 * how someone who could edit proposes a change for somebody else to decide
 * instead, and the review pass judges every suggestion against that draft.
 */
export function offersSuggest(r: {
  signedIn: boolean;
  /** `canSuggestDoc` for this reader. */
  maySuggest: boolean;
  mode: FrameMode;
  shownVersion: string;
  headVersion: string;
  expired: boolean;
}): boolean {
  return (
    r.signedIn &&
    r.maySuggest &&
    r.mode.kind === "reading" &&
    r.headVersion !== "" &&
    r.shownVersion === r.headVersion &&
    !r.expired
  );
}
