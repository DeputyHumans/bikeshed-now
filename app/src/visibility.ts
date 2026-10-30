// SPDX-License-Identifier: Apache-2.0
// Client for visibility, open editing and a folder's reach (SPEC §17).

import { ApiError, post } from "./api";
import { expiryMs } from "./expiry";
import type { DocMeta, FolderMeta, PublicDoc, Visibility } from "./types";

export interface VisibilityState {
  visibility: Visibility;
  publicEdit: boolean;
  /** Present only while unlisted. It IS the access control for that level. */
  linkToken: string | null;
  /** Epoch milliseconds, or null for a document that does not expire. */
  expiresAt: number | null;
}

/**
 * `publicEdit` widens WHO may edit to any verified account. It never widens to
 * "anyone": every write still requires a signed-in account, on every document,
 * whatever its owner chose (SPEC §17).
 */
export function setVisibility(
  docId: string,
  visibility: Visibility,
  publicEdit = false,
  /**
   * Epoch milliseconds, or null for no expiry.
   *
   * Sent on EVERY call, including the ones that only change visibility, because
   * the server writes the whole triple. Omitting it here would clear the date
   * as a side effect of ticking a different box — which is the kind of thing
   * nobody notices until the document is gone.
   */
  expiresAt: number | null = null,
): Promise<VisibilityState> {
  return post<VisibilityState>(
    "/visibility",
    { docId, visibility, publicEdit, expiresAt },
    { forbidden: "Only the document owner can change who can see this." },
  );
}

/**
 * A folder's own level and expiry: what its link or public level opens beneath
 * it, to read (SPEC §17 "A folder's reach"). Both sent every time, as for a
 * document, and there is no open editing to send.
 */
export function setFolderVisibility(
  folderId: string,
  visibility: Visibility,
  expiresAt: number | null = null,
): Promise<VisibilityState> {
  return post<Omit<VisibilityState, "publicEdit">>(
    "/visibility",
    { folderId, visibility, expiresAt },
    { forbidden: "Only the folder's owner can change who can see what is in it." },
  ).then((s) => ({ ...s, publicEdit: false }));
}

/** A folder's level, link and expiry, as the share dialog edits them. */
export function folderVisibilityStateOf(
  meta: Pick<FolderMeta, "visibility" | "linkToken" | "expiresAt">,
): VisibilityState {
  return {
    visibility: meta.visibility ?? "private",
    publicEdit: false,
    linkToken: meta.linkToken ?? null,
    expiresAt: expiryMs(meta.expiresAt),
  };
}

/**
 * The triple as a record carries it. Every field is optional there, because
 * most documents never set any of them, and what this returns is what the
 * dialog will send back whole on the first change it makes.
 */
export function visibilityStateOf(
  meta: Pick<DocMeta, "visibility" | "publicEdit" | "linkToken" | "expiresAt">,
): VisibilityState {
  return {
    visibility: meta.visibility ?? "private",
    publicEdit: meta.publicEdit ?? false,
    linkToken: meta.linkToken ?? null,
    expiresAt: expiryMs(meta.expiresAt),
  };
}

/** The link to share, including the unlisted token when there is one. */
export function shareUrl(docId: string, state: VisibilityState): string {
  return withKey(`${window.location.origin}/d/${docId}`, state);
}

/**
 * How far a folder's stored reach reaches right now — its own level's and
 * every ancestor's that has not ended — or null when nothing beyond its
 * members can read what is in it.
 */
export function liveReach(
  folder: Pick<FolderMeta, "reach"> | null | undefined,
  nowMs: number = Date.now(),
): "unlisted" | "public" | null {
  const live = (folder?.reach ?? []).filter((e) => e.expiresAt === null || e.expiresAt > nowMs);
  if (live.some((e) => e.visibility === "public")) return "public";
  return live.length > 0 ? "unlisted" : null;
}

/** A folder's link: its page, which opens everything beneath it. */
export function folderShareUrl(folderId: string, state: VisibilityState): string {
  return withKey(`${window.location.origin}/folder/${folderId}`, state);
}

function withKey(base: string, state: VisibilityState): string {
  return state.visibility === "unlisted" && state.linkToken
    ? `${base}?k=${state.linkToken}`
    : base;
}

/**
 * What a reader who is not a member may know about a document, from the one
 * endpoint that checks an unlisted document's key: the same shape as the public
 * projection, or null — one answer for absent, private, and unlisted without
 * the key. Signed in, presenting the key also records a link grant, which is
 * what lets the security rules accept this reader's comments (SPEC §17).
 */
export async function unlockDoc(docId: string, k: string | null): Promise<PublicDoc | null> {
  try {
    return await post<PublicDoc>("/unlock", k ? { docId, k } : { docId });
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

/** One level of a folder, as somebody holding its link (or nobody, if public) sees it. */
export interface SharedFolder {
  folderId: string;
  name: string;
  /** What opened it, and when that ends. */
  visibility: "unlisted" | "public";
  expiresAt: number | null;
  /** From the outermost folder this link opens down to this one. */
  path: { folderId: string; name: string }[];
  folders: { folderId: string; name: string }[];
  documents: {
    docId: string;
    title: string;
    currentVersion: string;
    /** When its current version was published. */
    updatedAt: number | null;
    /** Its current version's word count, for its reading time; null until counted. */
    words?: number | null;
    cover: { versionId: string; key: string } | null;
  }[];
  /** There were more than the server lists in one answer. */
  truncated: boolean;
}

export type FolderUnlock =
  | { open: SharedFolder }
  /** The link was right, or the folder was public, but its date has passed. */
  | { ended: { folderId: string; name: string; expiresAt: number | null } }
  | null;

/**
 * What one level of a folder holds, for a reader whose only claim is the
 * folder's link or public level. Null is one answer for absent, private, a
 * wrong key and a rotated one (SPEC §2 `POST /unlock`).
 */
export async function unlockFolder(folderId: string, k: string | null): Promise<FolderUnlock> {
  try {
    const answer = await post<SharedFolder | { folderId: string; name: string; expiresAt: number | null; expired: true }>(
      "/unlock",
      k ? { folderId, k } : { folderId },
    );
    return "expired" in answer
      ? { ended: { folderId: answer.folderId, name: answer.name, expiresAt: answer.expiresAt } }
      : { open: answer };
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}
