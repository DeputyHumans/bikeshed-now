// SPDX-License-Identifier: Apache-2.0
// Access decisions for documents and folders (SPEC §2, §8, §17).

import { timingSafeEqual } from "crypto";

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
  suggesters?: unknown;
  suggesterMembers?: unknown;
  editors?: unknown;
  editorMembers?: unknown;
  approvers?: unknown;
  approverMembers?: unknown;
  visibility?: unknown;
  publicEdit?: unknown;
  expiresAt?: unknown;
  linkToken?: unknown;
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
 * So the record stays readable and the CONTENT stops being served by the
 * functions. RTDB separately enforces the mirrored expiry on shared draft
 * bytes with its own server clock (SPEC §16, §17).
 */
export function isExpired(
  doc: DocAclData | null | undefined,
  nowMs: number,
): boolean {
  const at = expiryMs(doc);
  return at !== null && at <= nowMs;
}

/**
 * An expired document is READ-ONLY, and visible only to its owner.
 *
 * One sentence, enforced at every read and write path (SPEC §17 "Expiry"),
 * because expiry is not in the Firestore rules (see `isExpired`).
 * The owner keeps reading it because they are the one who set the date and the
 * one who can move it; locking them out of their own document would make the
 * setting unrecoverable rather than reversible. Everybody else gets the same
 * 404 a document they may not read gives them, so expiry does not become a way
 * to confirm that a slug exists.
 *
 * Writing is refused for EVERYONE, the owner included. An expired document is
 * frozen; lifting the date is what unfreezes it, and that is one action rather
 * than a special case in every write path. The single exception asks this
 * question instead of `isExpired`: `saveThumbs`, because a stored cover is not
 * the document, and the owner is the one reader it has left (SPEC §17).
 */
export function expiredForReader(
  doc: DocAclData,
  caller: { uid: string; emailLower: string } | null,
): boolean {
  if (!isExpired(doc, Date.now())) return false;
  return !(caller && canManageSharing(doc, caller.emailLower));
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
 * What a caller brings besides their identity to read an UNLISTED document:
 * the key from the link (`k`), and the token their account's link grant was
 * issued under (`docs/{id}/linkGrants/{uid}`, read by `lib/linkgrant.ts`).
 * Neither opens anything on a private or public document.
 */
export interface LinkProof {
  k?: string | null;
  grantToken?: string | null;
}

export const NO_PROOF: LinkProof = Object.freeze({});

/**
 * Constant-time comparison of a presented token against the stored one.
 *
 * Both must be non-empty strings: an absent stored token must never match an
 * absent or empty key. Byte lengths are compared first because timingSafeEqual
 * throws on unequal buffers, and a key of multi-byte characters can match the
 * token's length in characters while differing in bytes. The length itself is
 * not secret; every token is 22 characters.
 */
export function tokenMatches(stored: unknown, presented: unknown): boolean {
  if (typeof stored !== "string" || typeof presented !== "string") return false;
  if (stored.length === 0 || presented.length === 0) return false;
  const a = Buffer.from(stored, "utf8");
  const b = Buffer.from(presented, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * On what basis may this caller read the document's CONTENT? Null means not at
 * all, and every caller that gets null answers exactly as for an id that does
 * not exist (SPEC §1.4b, §17).
 *
 *   member  owner or effective member, at any visibility
 *   public  anyone, anonymous included
 *   link    unlisted, and the request carries the link's key
 *   grant   unlisted, and this account presented the key before, under the
 *           token the document holds NOW — rotating the link revokes it
 *
 * The distinction matters beyond yes/no: only `public` and `link` are decided
 * by the URL alone, so only they may be cached at a shared URL.
 *
 * A null caller is anonymous. Anonymous may read the bytes and nothing else —
 * no member list, no reviewer identity, no reading statistic. Those live behind
 * an account even on a public document, because publishing a document must not
 * publish the people who reviewed it.
 */
export type ReadBasis = "member" | "public" | "link" | "grant";

export function readBasis(
  doc: DocAclData | undefined | null,
  caller: { uid: string; emailLower: string } | null,
  proof: LinkProof = NO_PROOF,
): ReadBasis | null {
  if (!doc) return null;
  if (caller && isMember(doc, caller.uid, caller.emailLower)) return "member";
  const visibility = visibilityOf(doc);
  if (visibility === "public") return "public";
  if (visibility !== "unlisted") return null;
  if (tokenMatches(doc.linkToken, proof.k)) return "link";
  if (caller && tokenMatches(doc.linkToken, proof.grantToken)) return "grant";
  return null;
}

/**
 * May this caller read the document's CONTENT? Without a proof, an unlisted
 * document is unreadable to anyone but its members, so a call site that forgets
 * to pass one fails closed.
 */
export function canRead(
  doc: DocAclData | undefined | null,
  caller: { uid: string; emailLower: string } | null,
  proof: LinkProof = NO_PROOF,
): boolean {
  return readBasis(doc, caller, proof) !== null;
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
 * Does a new version written by `author` keep the document's trust (SPEC §6c)?
 *
 * Trust is the owner vouching for scripts they have seen. Only a version the
 * owner wrote in the app is still theirs to vouch for. Anybody else's —
 * an editor's, an open editor's — and anything through a token, which is an
 * upload in all but name, is content nobody vouched for, and is sandboxed
 * until somebody does.
 */
export function keepsTrust(
  doc: DocAclData | undefined | null,
  author: { emailLower: string; channel: string },
): boolean {
  return author.channel === "web" && canManageSharing(doc, author.emailLower);
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
  // An approver edits: accepting a suggestion is replayed as an edit in their
  // own session (SPEC §13). `editorMembers` already holds them; the direct list
  // is checked too, as `editors` is, for a record written before that set was.
  if (includesEmail(doc.approvers, emailLower)) return true;
  return includesEmail(doc.editorMembers, emailLower);
}

/**
 * May this person decide on a suggestion — accept or reject it (SPEC §13)?
 *
 * The owner, and approvers direct or inherited. Never widened by open editing
 * or by a link: deciding what someone else proposed is a role somebody was
 * given, not something reachable by holding a URL.
 */
export function isDocApprover(
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
  if (includesEmail(doc.approvers, emailLower)) return true;
  return includesEmail(doc.approverMembers, emailLower);
}

/**
 * May this caller propose a change for someone else to decide on?
 *
 * Suggesters, and everyone who may edit — including an open editor, who could
 * make the change outright and so loses nothing by being allowed to propose it.
 */
export function canSuggest(
  doc: DocAclData | undefined | null,
  caller: { uid: string; emailLower: string } | null,
  proof: LinkProof = NO_PROOF,
): boolean {
  if (!doc || !caller) return false;
  if (includesEmail(doc.suggesters, caller.emailLower)) return true;
  if (includesEmail(doc.suggesterMembers, caller.emailLower)) return true;
  return canEdit(doc, caller, proof);
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
  proof: LinkProof = NO_PROOF,
): boolean {
  if (!doc || !caller) return false;
  if (isDocEditor(doc, caller.uid, caller.emailLower)) return true;
  // Open editing widens who may edit among those who may READ: on an unlisted
  // document that is still only the people holding its link.
  return (
    doc.publicEdit === true &&
    isNonPrivate(doc) &&
    readBasis(doc, caller, proof) !== null
  );
}

/**
 * Does open editing reach an account nobody can name in advance — the realtime
 * `*` key? Only on a PUBLIC document. The realtime rules cannot see a link's
 * key, so an unlisted document's link holders edit through the draft endpoints,
 * which can (SPEC §16, §17).
 */
export function opensEditingToAnyAccount(
  doc: DocAclData | undefined | null,
): boolean {
  return doc?.publicEdit === true && visibilityOf(doc) === "public";
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
