// SPDX-License-Identifier: Apache-2.0
// The shared data contract (SPEC §4).

/**
 * These shapes MUST match what the endpoints, the publish CLI and
 * firestore.rules write and enforce. Field names are fixed by SPEC §4; do not
 * rename them here without changing the spec in the same commit.
 */

import type { Timestamp } from "firebase/firestore";

/** Who did this, through what, and which of that is trustworthy (SPEC §17). */
export interface Actor {
  /** Null only for the operator scripts, which authenticate as Admin, not as an account. */
  uid: string | null;
  email: string;
  /**
   * SERVER-DERIVED, from the credential, never the endpoint (ADR 0023). A
   * Bearer token cannot claim to be "web", the CLI reads "cli" wherever it
   * acts, an app connected by signing in reads "app", and firestore.rules pins
   * "web" on the direct client write path.
   */
  channel: "web" | "cli" | "mcp" | "api" | "app" | "operator";
  /** Which personal access token or app grant, when the channel is not "web". */
  tokenId?: string;
  /** SERVER-DERIVED. The credential in words, as it was when it acted (provenance.ts). */
  via?: string;
  /** SELF-REPORTED. Rendered as such; never presented as verified. */
  client?: string;
  /** SELF-REPORTED agent or model identifier. */
  agent?: string;
}

export type Visibility = "private" | "unlisted" | "public";
export type SourceFormat = "html" | "markdown";
/** Lowest first; each can do everything below it (SPEC §13). */
export type Role = "viewer" | "suggester" | "editor" | "approver";

/** Export marking, resolved at publish time so it is the OWNER's policy (SPEC §20). */
export interface Marking {
  enabled: boolean;
  label: string;
  /** Supports {year} {date} {title} {version} {user}. */
  footer: string;
}

/** Firestore: docs/{docId} */
export interface DocMeta {
  docId: string;
  title: string;
  slug: string;
  ownerUid: string | null;
  ownerEmail: string;
  currentVersion: string;

  /**
   * DIRECT grants: the record of intent. Entries are lowercased emails or
   * `team:{teamId}` references, which the server expands into `members`.
   */
  viewers: string[];
  editors: string[];
  /** Absent on a record written before the role existed: nobody holds it. */
  suggesters?: string[];
  approvers?: string[];

  /**
   * EFFECTIVE read set: the record of reality. Owner, direct grants, the parent
   * folder chain's grants, and every team grant expanded to the people in it —
   * all lowercased.
   *
   * This array is simultaneously the read gate and the workspace query key, and
   * the Firestore `list` rule is only valid because it is statically provable
   * from an array-contains filter. Anything that makes it something other than a
   * flat array of lowercased emails breaks the entire workspace (SPEC §5).
   */
  members: string[];
  /** EFFECTIVE editor set. Missing on legacy records: fall back to `editors`. */
  editorMembers?: string[];
  /** EFFECTIVE suggester and approver sets, each containing the role above it. */
  suggesterMembers?: string[];
  approverMembers?: string[];

  folderId?: string | null;

  /** Default private. Absent means private. */
  visibility?: Visibility;
  /** Widens WHO may edit to any verified account. Never to anyone (SPEC §17). */
  publicEdit?: boolean;
  /** Present only while visibility is "unlisted"; it IS the access control. */
  linkToken?: string;

  /**
   * When the CONTENT stops being served. Absent means never (SPEC §17).
   *
   * Not a deletion date. Nothing is removed, the versions and comments survive,
   * and the owner can move it or clear it. It is also not in the security
   * rules — the workspace list rule has to stay statically provable — so this
   * field is what the interface reads, and the server is what enforces it.
   */
  expiresAt?: Timestamp | number | null;

  /**
   * GLOBAL trust: whether the viewer sandboxes the content iframe for EVERY
   * reader. Every publish through an account — browser upload, fork, CLI and
   * MCP — writes false; only the operator script writes true, and the owner
   * flips it. Missing means trusted (SPEC §6c).
   */
  trusted?: boolean;

  marking?: Marking;

  /**
   * This document was forked from another. Deliberately the WHOLE of what the
   * record says about it: which document is answered by POST /fork, one hop at
   * a time and only to a caller who could open that hop, because every member
   * of a fork reads this record (SPEC §21).
   */
  forked?: boolean;

  createdAt: Timestamp;
  /**
   * Bumped by any change to the record: a publish, and also a rename, a share,
   * trust, a marking or a folder recompute. Deliberately NOT touched by a read.
   * "Updated" on a card is `latest.at`, which only a publish moves.
   */
  updatedAt: Timestamp;
  /** The current version, summarized (SPEC §4); absent until it is. */
  latest?: DocLatest;
  /** Set while it is in the Trash (SPEC §4); null once restored. */
  trashed?: TrashMark | null;

  liveEpoch?: string;
  draft?: DraftMeta | null;
  stats?: ViewStats;
  /** Which version's thumbnails are stored. Admin SDK only; never moves `updatedAt`. */
  thumb?: DocThumb;
}

/**
 * Firestore: docs/{docId}.stats — the denormalized usage rollup.
 *
 * Lives ON the document so the workspace renders counts with no extra reads and
 * every member sees the aggregate. Written only by the Admin SDK, always as a
 * nested map under set/merge, so the view writer and the edit writer cannot
 * clobber each other. Missing means treat every counter as zero.
 */
/**
 * `docs/{docId}.thumb` (SPEC §4): the keys a version's stored thumbnails live
 * under. It can name an older version than `currentVersion` until an editor
 * next opens the document.
 */
export interface DocThumb {
  versionId: string;
  /** The capture revision that made these images; absent on the first. */
  rev?: number;
  /** Key of the workspace card's cover. */
  cover?: string;
  /** Key and count of a deck's rail images, `s0` … `s{count-1}`. */
  slides?: { key: string; count: number };
}

export interface ViewStats {
  views: number;
  viewers: number;
  totalMs: number;
  lastViewedAt?: Timestamp;
  commits: number;
  lastEditedAt?: Timestamp;
  lastEditedByEmail?: string;
  /**
   * Automated reads, counted SEPARATELY and never folded into `views` or
   * `totalMs`. An agent fetching a document forty times would otherwise make
   * both meaningless, and reading time is not a concept that applies to a
   * machine fetch (SPEC §17).
   */
  apiReads?: number;
  /** Forks made from this document, those in the Trash included; one deleted forever takes itself off (SPEC §21). */
  forks?: number;
}

/** Firestore: docs/{docId}/viewers/{uid} — per-account rollup. Editor-gated. */
export interface ViewerStat {
  uid: string;
  email: string;
  views: number;
  totalMs: number;
  firstViewedAt?: Timestamp;
  lastViewedAt?: Timestamp;
}

/**
 * Firestore: docs/{docId}/trust/{uid} — PERSONAL trust.
 *
 * Lifts the untrusted-content sandbox for THIS ACCOUNT ONLY, so any reader may
 * grant it to themselves: the only session exposed to the bundle's JS is their
 * own. Never writes DocMeta.trusted (SPEC §6c).
 */
export interface PersonalTrust {
  uid: string;
  email: string;
  trustedAt: Timestamp;
}

/**
 * In the Trash (SPEC §4): when, by whose uid (the owner's, or the owner of the
 * folder it went with), the batch shared by everything trashed together, and
 * the folder it went with, as it was named then.
 */
export interface TrashMark {
  at: Timestamp | null;
  by: string;
  batch: string;
  with?: { folderId: string; name: string };
}

/** Firestore: folders/{folderId} — a sharing container that nests (SPEC §13). */
export interface FolderMeta {
  folderId: string;
  name: string;
  slug: string;
  parentId: string | null;
  ownerUid: string | null;
  ownerEmail: string;
  viewers: string[];
  editors: string[];
  suggesters?: string[];
  approvers?: string[];
  members: string[];
  editorMembers: string[];
  /** Root-first folder ids: breadcrumb, subtree and cycle guard in one field. */
  ancestors: string[];
  depth: number;
  /**
   * The folder's own level, link and expiry: what its reach opens beneath it,
   * to read (SPEC §17 "A folder's reach"). Absent on most folders: private.
   */
  visibility?: Visibility;
  linkToken?: string;
  expiresAt?: Timestamp;
  /** This folder's reach and every ancestor's, root first; server-written. */
  reach?: ReachEntry[];
  /** Set while it is in the Trash, as on a document (SPEC §4). */
  trashed?: TrashMark | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** One folder whose link or public level opens what is beneath it. Never carries the key. */
export interface ReachEntry {
  folderId: string;
  visibility: "unlisted" | "public";
  keyHash?: string;
  /** Epoch milliseconds, or null when it does not end. */
  expiresAt: number | null;
}

/**
 * A folder above a record whose link or public level reaches it, from GET
 * /access or /folder-access (SPEC §2). Read-only in the share panel, like an
 * inherited grant: it is changed on the folder.
 */
export interface InheritedReach {
  folderId: string;
  /** The folder's path, `…` for each level the owner cannot open. */
  path: string;
  visibility: "unlisted" | "public";
  /** Epoch milliseconds, past ones included; null when it does not end. */
  expiresAt: number | null;
}

/**
 * One grant a record inherits, from GET /access or /folder-access (SPEC §13).
 * Read-only in the share panel: it is changed on the folder it is made on.
 */
export interface InheritedGrant {
  folderId: string;
  /** The folder's path, `…` for each level the owner cannot open. */
  path: string;
  /** An email, or `team:{id}`. */
  principal: string;
  role: Role;
}

/**
 * Firestore: teams/{teamId} — an access grant, never a principal (SPEC §18).
 *
 * A document always has a person as owner. A team is something you can grant to.
 */
export interface TeamMeta {
  teamId: string;
  name: string;
  slug: string;
  ownerEmail: string;
  admins: string[];
  members: string[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** Firestore: users/{uid}. Verification state and cooldowns are server-only. */
export interface UserRecord {
  uid: string;
  email: string;
  displayName?: string;
  photoURL?: string;
  providers?: string[];
  emailNotifications?: boolean;
  analyticsOptOut?: boolean;
  defaultMarking?: Marking;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

/**
 * Firestore: users/{uid}/tokens/{tokenId} — metadata only; never the secret.
 *
 * A connected app (SPEC §23) is a row here too, with `kind: "oauth"`, so the
 * same list shows it and the same Revoke ends it. No `kind` means a personal
 * access token.
 */
export interface TokenSummary {
  tokenId: string;
  /** For a connected app, the app's name — its own claim unless verified. */
  name: string;
  channel: "cli" | "mcp" | "api";
  createdAt?: Timestamp;
  lastUsedAt?: Timestamp;
  revokedAt?: Timestamp | null;
  kind?: "oauth";
  /** The checked host, or the redirect host for DCR; null for a local program. */
  clientHost?: string | null;
  clientVerified?: boolean;
  registration?: "cimd" | "dcr";
  /** When the connection lapses if nothing uses it. */
  expiresAt?: Timestamp;
}

/**
 * Firestore: public/{docId} — the world-readable projection of a PUBLIC
 * document. POST /unlock returns the same shape, without `publishedAt`, to a
 * reader holding an unlisted document's key (SPEC §2, §17).
 */
export interface PublicDoc {
  docId: string;
  title: string;
  slug: string;
  currentVersion: string;
  /** Non-secret live-editing generation; absent on older projections. */
  liveEpoch?: string;
  entry: string;
  format: SourceFormat;
  /** Current-version download choices; older projections may omit these. */
  sourceEntry?: string | null;
  fileCount?: number;
  visibility: "unlisted" | "public";
  publicEdit: boolean;
  trusted: boolean;
  /** Owner-controlled export policy; absent only on older reader projections. */
  marking?: Marking;
  /** Epoch milliseconds, or null. Carried so an anonymous reader is told. */
  expiresAt: number | null;
  /** That it is a fork, and nothing about of what (SPEC §21). Absent on older mirrors. */
  forked?: boolean;
  /**
   * This reader's access comes from a folder's link or public level, and is
   * read-only: no comments, no presence, no editing (SPEC §17). `expiresAt` is
   * then when THEIR access ends. Absent on older mirrors.
   */
  viaFolder?: boolean;
  /**
   * When the current version was published (not the last rename or re-share),
   * in epoch milliseconds, as the folder listing's `updatedAt`. Absent on
   * older projections.
   */
  updatedAt?: number | null;
  /** The same instant as a timestamp, on the mirror only, which the sitemap orders by. */
  publishedAt?: Timestamp;
  /** The current version's word count, for its reading time; null until counted. */
  words?: number | null;
}

/**
 * docs/{id}.latest: the current version, summarized by the version-write
 * trigger (functions/src/lib/latest.ts), for a card that cannot read versions.
 * Absent on a document not summarized yet.
 */
export interface DocLatest {
  version: string;
  at: Timestamp | null;
  byEmail: string | null;
  channel: string;
  via?: string;
  origin: "upload" | "edit" | "fork" | null;
  words?: number;
}

/** One person's stint of editing a draft, derived from their saves (SPEC §17). */
export interface EditSession {
  email: string;
  actor: Actor;
  from: number;
  to: number;
}

/** Firestore: docs/{docId}.draft — the shared, in-progress edit. */
export interface DraftMeta {
  causal?: { generation: string; vector: Record<string, number>; deletesJson: string };
  baseVersion: string;
  entry: string;
  /** Present for a Markdown-authored document: the canonical source file. */
  sourceEntry?: string;
  bytes: number;
  updatedAt: Timestamp;
  updatedByEmail: string;
  editSessions?: EditSession[];
}

/** Firestore: docs/{docId}/versions/{versionId} — immutable, but for `words`, which the version trigger adds once. */
export interface DocVersion {
  versionId: string;
  label: string;
  /** The file the iframe loads. For Markdown, the COMPILED HTML. */
  entry: string;
  format?: SourceFormat;
  /** For Markdown: the authored source, which is canonical. */
  sourceEntry?: string;
  /** Pinned renderer identity, so "why did the hash move" has an answer. */
  rendererVersion?: string;
  storagePrefix: string;
  fileCount: number;
  bytes: number;
  /** sha256 over the bundle; identical bytes republish as a no-op (SPEC §9.1). */
  contentHash: string;
  files?: string[];
  parentVersion?: string | null;
  /** "duplicate" is the legacy name of "fork", on copies made before lineage was recorded. */
  /** How the content arrived, apart from who sent it; absent on a version published before it was stored. */
  origin?: "upload" | "edit" | "fork";
  /** The older single field, derived from `origin` and the channel since `origin` exists. */
  publishedVia?: "cli" | "upload" | "editor" | "mcp" | "api" | "app" | "operator" | "fork" | "duplicate";
  publishedByEmail?: string;
  publishedBy?: Actor;
  /** Words in its entry, counted by the version trigger for its reading time; absent until counted. */
  words?: number;
  /** Carried from the draft: who actually wrote this version (SPEC §17). */
  editSessions?: EditSession[];
  publishedAt: Timestamp;
}

/** A W3C-style text anchor, scoped to a stable container id (SPEC §6). */
export interface Anchor {
  /** The nearest id-bearing ancestor. Scoping here is what makes anchors survive edits. */
  elementId: string;
  exact: string;
  prefix: string;
  suffix: string;
  /** Position fallback, relative to the elementId root. */
  start: number;
  end: number;
  /**
   * Found by its quote on the server, with no DOM (an agent's comment, SPEC
   * §19). Its offsets are a hint inside one block, not positions in the page,
   * so it is resolved by its exact text or not at all — never by position.
   */
  strict?: boolean;
}

/** Firestore: docs/{docId}/versions/{versionId}/annotations/{annId} */
export interface Annotation {
  annId: string;
  anchor: Anchor;
  authorUid: string;
  authorEmail: string;
  /** Immutable after creation; `channel` is pinned to "web" by the rules. */
  actor: Actor;
  color: string;
  resolved: boolean;
  createdAt: Timestamp;
  /** Present when this annotation is a suggested edit (SPEC §22). Server-written only. */
  suggestion?: Suggestion;
}

export type SuggestionState = "pending" | "accepted" | "rejected" | "withdrawn";

/** A proposed text replacement for the annotation's quote. Empty deletes it. */
export interface Suggestion {
  replacement: string;
  state: SuggestionState;
  /** Held by the approver applying it, so nobody else does at the same time. */
  claim?: { uid: string; email: string; until: Timestamp };
  /** Who closed it, and when: an approver's decision, or its author withdrawing it. */
  decidedBy?: Actor;
  decidedAt?: Timestamp;
  /** Each change its author made, oldest first, holding what it replaced. */
  revisions?: SuggestionRevision[];
}

/** The replacement (and the author's note, if one was replaced) a change superseded. */
export interface SuggestionRevision {
  replacement: string;
  note?: string;
  at: Timestamp;
  actor: Actor;
}

/** Firestore: .../annotations/{annId}/comments/{commentId} */
export interface Comment {
  commentId: string;
  body: string;
  authorUid: string;
  authorEmail: string;
  actor: Actor;
  createdAt: Timestamp;
  /** The first comment of a suggestion's thread (SPEC §22). */
  opensSuggestion?: boolean;
  /** Words the server wrote — a restated change, or a decision — not the author's. */
  generated?: boolean;
}

/** The typed outcomes of POST /session. Not error strings (SPEC §2). */
export type SessionStatus =
  | "ok"
  | "unverified"
  | "not_allowed"
  | "session_failed"
  /** Google renamed the account, and a job is moving it to the new address (SPEC §14). */
  | "moving";
