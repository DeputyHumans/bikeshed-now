// SPDX-License-Identifier: Apache-2.0
// Typed Firestore reads and the two client write paths (SPEC §4, §5, §6).

import {
  collection,
  deleteDoc,
  doc,
  getDoc as fbGetDoc,
  getDocs,
  limit as fbLimit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type Timestamp,
  type Unsubscribe,
} from "firebase/firestore";

import { db } from "./firebase";
import { TOKENS } from "./brand/tokens";
import type {
  AclChange,
  Actor,
  Anchor,
  Annotation,
  Comment,
  DocMeta,
  DocVersion,
  FolderMeta,
  PublicDoc,
  TeamMeta,
  TokenSummary,
  UserRecord,
  ViewSession,
  ViewerStat,
} from "./types";

/**
 * Reads go straight to the Web SDK and are gated by firestore.rules. The only
 * things a client WRITES here are annotations, comments, personal trust and its
 * own user record — everything else goes through an endpoint, because
 * firestore.rules denies it.
 */

// --- Workspace -------------------------------------------------------------

/**
 * Live list of documents the signed-in user may view.
 *
 * ONE query suffices, because the owner, every inherited folder grant and every
 * expanded team grant are already in `members`. The matching rule is only valid
 * because it is statically provable from this exact filter, so the filter value
 * must be the caller's own lowercased address and nothing else (SPEC §5).
 */
export function listMyDocs(
  emailLower: string,
  onData: (docs: DocMeta[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  const q = query(
    collection(db, "docs"),
    where("members", "array-contains", emailLower),
    orderBy("createdAt", "desc"),
  );
  return onSnapshot(
    q,
    (snap) => onData(snap.docs.map((d) => ({ ...(d.data() as DocMeta), docId: d.id }))),
    (err) => onError?.(err),
  );
}

/** Live list of folders. Same single array-contains shape as documents. */
export function listMyFolders(
  emailLower: string,
  onData: (folders: FolderMeta[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  const q = query(
    collection(db, "folders"),
    where("members", "array-contains", emailLower),
    orderBy("createdAt", "desc"),
  );
  return onSnapshot(
    q,
    (snap) =>
      onData(snap.docs.map((d) => ({ ...(d.data() as FolderMeta), folderId: d.id }))),
    (err) => onError?.(err),
  );
}

/** Live list of the teams this account belongs to. */
export function listMyTeams(
  emailLower: string,
  onData: (teams: TeamMeta[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  const q = query(
    collection(db, "teams"),
    where("members", "array-contains", emailLower),
    orderBy("createdAt", "desc"),
  );
  return onSnapshot(
    q,
    (snap) => onData(snap.docs.map((d) => ({ ...(d.data() as TeamMeta), teamId: d.id }))),
    (err) => onError?.(err),
  );
}

// --- One document ----------------------------------------------------------

export async function getDoc(docId: string): Promise<DocMeta | null> {
  const snap = await fbGetDoc(doc(db, "docs", docId));
  return snap.exists() ? { ...(snap.data() as DocMeta), docId: snap.id } : null;
}

/**
 * The world-readable projection.
 *
 * What an anonymous reader — and a signed-in non-member — gets instead of the
 * document record, which carries member lists and reading statistics that
 * Firestore rules cannot project away (SPEC §17).
 */
export async function getPublicDoc(docId: string): Promise<PublicDoc | null> {
  const snap = await fbGetDoc(doc(db, "public", docId));
  return snap.exists() ? (snap.data() as PublicDoc) : null;
}

/** Live document metadata: how the viewer notices a peer's save or publish. */
export function watchDoc(
  docId: string,
  onData: (meta: DocMeta | null) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  return onSnapshot(
    doc(db, "docs", docId),
    (snap) => onData(snap.exists() ? { ...(snap.data() as DocMeta), docId: snap.id } : null),
    (err) => onError?.(err),
  );
}

/** Versions are immutable, so a one-shot read is correct. Oldest first. */
export async function listVersions(docId: string): Promise<DocVersion[]> {
  const q = query(
    collection(db, "docs", docId, "versions"),
    orderBy("publishedAt", "asc"),
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ ...(d.data() as DocVersion), versionId: d.id }));
}

export async function getVersion(
  docId: string,
  versionId: string,
): Promise<DocVersion | null> {
  const snap = await fbGetDoc(doc(db, "docs", docId, "versions", versionId));
  return snap.exists() ? { ...(snap.data() as DocVersion), versionId: snap.id } : null;
}

// --- Annotations and comments ----------------------------------------------

export function listAnnotations(
  docId: string,
  versionId: string,
  onData: (anns: Annotation[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  const q = query(
    collection(db, "docs", docId, "versions", versionId, "annotations"),
    orderBy("createdAt", "asc"),
  );
  return onSnapshot(
    q,
    (snap) => onData(snap.docs.map((d) => ({ ...(d.data() as Annotation), annId: d.id }))),
    (err) => onError?.(err),
  );
}

/**
 * The actor for a direct client write.
 *
 * `channel: "web"` is not a claim the client gets to make: firestore.rules PINS
 * it, because a rules-evaluated write IS the web channel by definition —
 * automation arrives through the Admin SDK, which bypasses rules entirely. Any
 * other value here is rejected (SPEC §17).
 */
function webActor(uid: string, emailLower: string): Actor {
  return { uid, email: emailLower, channel: "web" };
}

export async function createAnnotation(
  docId: string,
  versionId: string,
  anchor: Anchor,
  authorUid: string,
  authorEmail: string,
): Promise<string> {
  const ref = doc(
    collection(db, "docs", docId, "versions", versionId, "annotations"),
  );
  const emailLower = authorEmail.toLowerCase();
  await setDoc(ref, {
    annId: ref.id,
    anchor,
    authorUid,
    authorEmail: emailLower,
    actor: webActor(authorUid, emailLower),
    color: TOKENS.annotation,
    resolved: false,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export async function setResolved(
  docId: string,
  versionId: string,
  annId: string,
  resolved: boolean,
): Promise<void> {
  // The rules allow exactly this field to change, so this is the whole update.
  await updateDoc(
    doc(db, "docs", docId, "versions", versionId, "annotations", annId),
    { resolved },
  );
}

export async function deleteAnnotation(
  docId: string,
  versionId: string,
  annId: string,
): Promise<void> {
  await deleteDoc(doc(db, "docs", docId, "versions", versionId, "annotations", annId));
}

export function listComments(
  docId: string,
  versionId: string,
  annId: string,
  onData: (comments: Comment[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  const q = query(
    collection(
      db,
      "docs",
      docId,
      "versions",
      versionId,
      "annotations",
      annId,
      "comments",
    ),
    orderBy("createdAt", "asc"),
  );
  return onSnapshot(
    q,
    (snap) => onData(snap.docs.map((d) => ({ ...(d.data() as Comment), commentId: d.id }))),
    (err) => onError?.(err),
  );
}

export async function addComment(
  docId: string,
  versionId: string,
  annId: string,
  body: string,
  authorUid: string,
  authorEmail: string,
): Promise<string> {
  const ref = doc(
    collection(db, "docs", docId, "versions", versionId, "annotations", annId, "comments"),
  );
  const emailLower = authorEmail.toLowerCase();
  await setDoc(ref, {
    commentId: ref.id,
    body,
    authorUid,
    authorEmail: emailLower,
    actor: webActor(authorUid, emailLower),
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

// --- Statistics and provenance ---------------------------------------------
// The AGGREGATE rides on DocMeta.stats and needs no query. These read the
// per-person detail, which the rules gate to owner and real editors — callers
// must only invoke them when the user can edit, or the read is rejected.

export async function listDocViewers(docId: string): Promise<ViewerStat[]> {
  const q = query(
    collection(db, "docs", docId, "viewers"),
    orderBy("lastViewedAt", "desc"),
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ ...(d.data() as ViewerStat), uid: d.id }));
}

export async function listViewSessions(docId: string, max = 50): Promise<ViewSession[]> {
  const q = query(
    collection(db, "docs", docId, "views"),
    orderBy("startedAt", "desc"),
    fbLimit(max),
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ ...(d.data() as ViewSession), sessionId: d.id }));
}

/** The ACL change log: who granted whom access, from where (SPEC §17). */
export async function listAclChanges(docId: string, max = 50): Promise<AclChange[]> {
  const q = query(collection(db, "docs", docId, "acl"), orderBy("at", "desc"), fbLimit(max));
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data() as AclChange);
}

// --- Account ---------------------------------------------------------------

export function watchUser(
  uid: string,
  onData: (record: UserRecord | null) => void,
): Unsubscribe {
  return onSnapshot(
    doc(db, "users", uid),
    (snap) => onData(snap.exists() ? (snap.data() as UserRecord) : null),
    () => onData(null),
  );
}

/**
 * Write the client-settable part of the account record.
 *
 * Verification state and email cooldowns are absent on purpose: the rules
 * refuse them, because a user who can clear their own verification flag can
 * claim any address, and one who can clear their own cooldown can send
 * themselves unlimited mail.
 */
export async function saveUserProfile(
  uid: string,
  emailLower: string,
  fields: Partial<Pick<UserRecord, "displayName" | "photoURL" | "providers" | "emailNotifications" | "analyticsOptOut" | "defaultMarking">>,
): Promise<void> {
  await setDoc(
    doc(db, "users", uid),
    { uid, email: emailLower, ...fields, updatedAt: serverTimestamp() },
    { merge: true },
  );
}

export function watchMyTokens(
  uid: string,
  onData: (tokens: TokenSummary[]) => void,
): Unsubscribe {
  const q = query(collection(db, "users", uid, "tokens"), orderBy("createdAt", "desc"));
  return onSnapshot(
    q,
    (snap) => onData(snap.docs.map((d) => ({ ...(d.data() as TokenSummary), tokenId: d.id }))),
    () => onData([]),
  );
}

// --- Formatting ------------------------------------------------------------

export function formatTimestamp(ts: Timestamp | null | undefined): string {
  // A pending server timestamp reads as null locally. An ellipsis is honest;
  // rendering "now" would be a lie that lasts until the write lands.
  if (!ts) return "…";
  return ts.toDate().toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** Compact duration for a stat tile: "just under a minute" reads as "<1m". */
export function formatDuration(ms: number | null | undefined): string {
  if (!ms || ms < 0) return "0m";
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return "<1m";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/** Relative "when" for card meta lines. Falls back to absolute past a week. */
export function formatRelative(ts: Timestamp | null | undefined): string {
  if (!ts) return "never";
  const then = ts.toDate();
  const seconds = Math.floor((Date.now() - then.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days <= 7) return `${days}d ago`;
  return then.toLocaleDateString(undefined, { dateStyle: "medium" });
}
