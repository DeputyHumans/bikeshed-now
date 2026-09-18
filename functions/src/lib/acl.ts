// SPDX-License-Identifier: Apache-2.0
// Access decisions for documents and folders (SPEC §2, §8, §17).

/**
 * These functions MUST mirror firestore.rules. The rules are the real boundary
 * for anything a client reads directly; these are the boundary for everything
 * the endpoints do with the Admin SDK, which bypasses rules entirely. If the two
 * disagree, one of them is wrong, and which one is wrong is not obvious from
 * either side. `functions/test/access.test.js` and `rules-tests/` assert the
 * same decision table against both.
 */

export type Visibility = "private" | "unlisted" | "public";

/** The subset of a stored document these decisions actually read. */
export interface DocAclData {
  ownerUid?: string | null;
  ownerEmail?: string | null;
  members?: unknown;
  editors?: unknown;
  editorMembers?: unknown;
  visibility?: unknown;
  publicEdit?: unknown;
  expiresAt?: unknown;
}

function includesEmail(list: unknown, emailLower: string): boolean {
  return Array.isArray(list) && list.includes(emailLower);
}

/**
 * Expiry, in epoch milliseconds, or null when the document does not expire.
 *
 * Accepts both shapes deliberately. Firestore hands back a `Timestamp`; an
 * endpoint receives a number over JSON; and a document written before this
 * field existed has neither. Normalising in one place is what stops each caller
 * inventing its own idea of what an absent or malformed value means — and the
 * answer that matters is that anything it cannot read is NOT an expiry, so a
 * corrupt field can never lock a document away.
 */
export function expiryMs(doc: DocAclData | null | undefined): number | null {
  const v = doc?.expiresAt;
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const toMillis = (v as { toMillis?: () => number }).toMillis;
  if (typeof toMillis === "function") {
    const ms = toMillis.call(v);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/**
 * Has the owner's expiry passed?
 *
 * Expiry is NOT part of the ACL, and keeping it out of `canRead` is deliberate.
 * `canRead` mirrors `firestore.rules canRead`, and the rules cannot carry this
 * one: the workspace list rule has to be statically provable from the query's
 * constraints (SPEC §5), and a query cannot filter on a field most documents do
 * not have without dropping every document that does not have it.
 *
 * So the record stays readable and the CONTENT stops being served. Every byte
 * in this system already flows through one function, which is exactly the
 * property that makes enforcing it there sufficient (SPEC §17).
 */
export function isExpired(
  doc: DocAclData | null | undefined,
  nowMs: number,
): boolean {
  const at = expiryMs(doc);
  return at !== null && at <= nowMs;
}

/** Absent `visibility` means private. That is what keeps the default unchanged. */
export function visibilityOf(doc: DocAclData | null | undefined): Visibility {
  const v = doc?.visibility;
  return v === "public" || v === "unlisted" ? v : "private";
}

export function isNonPrivate(doc: DocAclData | null | undefined): boolean {
  return visibilityOf(doc) !== "private";
}

/** Owner by uid, or an email present in the effective read set. */
export function isMember(
  doc: DocAclData | undefined | null,
  uid: string,
  emailLower: string,
): boolean {
  if (!doc) return false;
  if (doc.ownerUid != null && uid === doc.ownerUid) return true;
  return includesEmail(doc.members, emailLower);
}

/**
 * May this caller read the document's CONTENT?
 *
 * A null caller is anonymous. Anonymous may read the bytes of a non-private
 * document and nothing else — no member list, no reviewer identity, no reading
 * statistic. Those live behind an account even on a public document, because
 * publishing a document must not publish the people who reviewed it.
 */
export function canRead(
  doc: DocAclData | undefined | null,
  caller: { uid: string; emailLower: string } | null,
): boolean {
  if (!doc) return false;
  if (isNonPrivate(doc)) return true;
  if (!caller) return false;
  return isMember(doc, caller.uid, caller.emailLower);
}

/** Owner-only: the gate for sharing, trust, visibility and marking changes. */
export function canManageSharing(
  doc: DocAclData | undefined | null,
  emailLower: string,
): boolean {
  if (!doc) return false;
  return (
    typeof doc.ownerEmail === "string" &&
    doc.ownerEmail.toLowerCase() === emailLower
  );
}

/**
 * The REAL editor set: owner, direct editors, or effective editors (folder and
 * team grants, expanded server-side).
 *
 * Kept separate from `canEdit` because open editing on a public document must
 * not hand a stranger the per-person reading history of everyone who opened it.
 * This — not canEdit — gates the stats subcollections and the activity feed.
 */
export function isDocEditor(
  doc: DocAclData | undefined | null,
  uid: string,
  emailLower: string,
): boolean {
  if (!doc) return false;
  if (doc.ownerUid != null && uid === doc.ownerUid) return true;
  if (
    typeof doc.ownerEmail === "string" &&
    doc.ownerEmail.toLowerCase() === emailLower
  ) {
    return true;
  }
  if (includesEmail(doc.editors, emailLower)) return true;
  return includesEmail(doc.editorMembers, emailLower);
}

/**
 * May this caller EDIT the content?
 *
 * `publicEdit` widens WHO to "any verified account". It never widens to
 * "anyone": a null caller is always refused, so anonymous stays read-only
 * everywhere, on every document, whatever its owner chose.
 */
export function canEdit(
  doc: DocAclData | undefined | null,
  caller: { uid: string; emailLower: string } | null,
): boolean {
  if (!doc || !caller) return false;
  if (isDocEditor(doc, caller.uid, caller.emailLower)) return true;
  return doc.publicEdit === true && isNonPrivate(doc);
}

// --- Folders ---------------------------------------------------------------
// Folders mirror documents: `members` is the effective read set (self + every
// ancestor's grants) and `editorMembers` the effective editor set.

export interface FolderAclData {
  ownerUid?: string | null;
  ownerEmail?: string | null;
  members?: unknown;
  editorMembers?: unknown;
}

export function canReadFolder(
  folder: FolderAclData | undefined | null,
  uid: string,
  emailLower: string,
): boolean {
  if (!folder) return false;
  if (folder.ownerUid != null && uid === folder.ownerUid) return true;
  return includesEmail(folder.members, emailLower);
}

/**
 * May the caller change what is INSIDE the folder — create a child, move items
 * in, rename it? Authorizes createFolder and organize against a destination.
 */
export function canEditFolder(
  folder: FolderAclData | undefined | null,
  uid: string,
  emailLower: string,
): boolean {
  if (!folder) return false;
  if (folder.ownerUid != null && uid === folder.ownerUid) return true;
  if (
    typeof folder.ownerEmail === "string" &&
    folder.ownerEmail.toLowerCase() === emailLower
  ) {
    return true;
  }
  return includesEmail(folder.editorMembers, emailLower);
}

/** May the caller change the folder's OWN sharing? Owner by email only. */
export function canManageFolder(
  folder: FolderAclData | undefined | null,
  emailLower: string,
): boolean {
  if (!folder) return false;
  return (
    typeof folder.ownerEmail === "string" &&
    folder.ownerEmail.toLowerCase() === emailLower
  );
}

// --- Teams -----------------------------------------------------------------

export interface TeamAclData {
  ownerEmail?: string | null;
  admins?: unknown;
  members?: unknown;
}

export function isTeamMember(
  team: TeamAclData | undefined | null,
  emailLower: string,
): boolean {
  if (!team) return false;
  return includesEmail(team.members, emailLower);
}

/** Owner or an admin. Gates add/remove and rename/delete. */
export function canManageTeam(
  team: TeamAclData | undefined | null,
  emailLower: string,
): boolean {
  if (!team) return false;
  if (
    typeof team.ownerEmail === "string" &&
    team.ownerEmail.toLowerCase() === emailLower
  ) {
    return true;
  }
  return includesEmail(team.admins, emailLower);
}
