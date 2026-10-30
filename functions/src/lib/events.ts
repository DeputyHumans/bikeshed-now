// SPDX-License-Identifier: Apache-2.0
// A document's change log: what records an event, and the cursor a reader resumes from (SPEC §4, §19, ADR 0016).

import * as admin from "firebase-admin";
import { FieldPath, FieldValue, Timestamp } from "firebase-admin/firestore";
import { viaLabel, type Actor } from "./actor";
import { safeSegment } from "./http";

type Db = admin.firestore.Firestore;
type DocRef = admin.firestore.DocumentReference;
type Writer = admin.firestore.WriteBatch | admin.firestore.Transaction;

/**
 * Why a log, and not a query per source
 * -------------------------------------
 * An agent watching a document asks one question every few minutes: what
 * happened since I last looked. Answered from the records that exist, that is a
 * query per open thread, and it still misses what leaves no record: a version
 * withdrawn, a visibility changed, a resolve made in the browser. So each
 * change appends one event here, and `get_changes` reads them in the order they
 * were recorded. ADR 0016 records the trade.
 *
 * Three rules hold the log honest:
 * - `at` is when the EVENT was written, by the server's clock. A cursor is a
 *   position in that order, so an event recorded after a poll always sorts
 *   after that poll, however late its trigger ran.
 * - An event is created, never overwritten. A redelivered trigger therefore
 *   writes nothing, where an overwrite would move `at` past a cursor and report
 *   the event twice.
 * - No body is stored, and no actor's email: both are joined from the source
 *   record when the log is read, so a deleted comment drops out of the feed
 *   instead of living on in it, and an account that moved address reads under
 *   its new one. An access change does keep the addresses it granted or
 *   removed, because a grant is to an address (ADR 0004).
 */

export type EventType =
  | "version.published"
  | "version.withdrawn"
  | "thread.opened"
  | "thread.resolved"
  | "thread.reopened"
  | "suggestion.opened"
  | "suggestion.revised"
  | "suggestion.accepted"
  | "suggestion.rejected"
  | "suggestion.withdrawn"
  | "comment.added"
  | "doc.renamed"
  | "doc.expiry"
  | "doc.moved"
  | "doc.visibility"
  | "doc.trust"
  | "doc.trashed"
  | "doc.restored"
  | "access.changed"
  | "fork.created";

/** Who may read an event: every reader, the document's editors, or its owner alone. */
export type EventAudience = "readers" | "editors" | "owner";

/** Who caused an event, without an address: that is joined at read time. */
export interface EventActor {
  uid: string | null;
  channel: string;
  tokenId?: string;
  /** The credential in words, as it was when it acted (lib/actor.ts). */
  via?: string;
}

export interface EventInput {
  type: EventType;
  audience: EventAudience;
  version?: string;
  threadId?: string;
  commentId?: string;
  actor?: EventActor | null;
  data?: Record<string, unknown>;
}

/** The log's own part of an actor: uid, channel, token and its words, never the email. */
export function eventActor(actor: Partial<Actor> | null | undefined): EventActor | null {
  if (!actor || typeof actor.channel !== "string") return null;
  return {
    uid: typeof actor.uid === "string" ? actor.uid : null,
    channel: actor.channel,
    ...(typeof actor.tokenId === "string" && actor.tokenId ? { tokenId: actor.tokenId } : {}),
    ...(typeof actor.via === "string" && actor.via ? { via: actor.via } : {}),
  };
}

/** Who withdraws a version: only scripts/delete-version.mjs does, as nobody. */
const OPERATOR: EventActor = { uid: null, channel: "operator", via: viaLabel("operator") };

/**
 * Whether a reader may see an event: the audience it was written for, said once
 * for get_changes and the Activity feed alike (SPEC §17, §21).
 */
export function eventVisibleTo(event: { audience?: unknown }, reader: { editor: boolean; owner: boolean }): boolean {
  if (event.audience === "editors") return reader.editor;
  if (event.audience === "owner") return reader.owner;
  return true;
}

/** The stored shape of an event, for a writer that has to choose its id itself. */
export function eventRecord(input: EventInput): Record<string, unknown> {
  return {
    at: FieldValue.serverTimestamp(),
    type: input.type,
    audience: input.audience,
    ...(input.version ? { version: input.version } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...(input.commentId ? { commentId: input.commentId } : {}),
    ...(input.actor ? { actor: input.actor } : {}),
    ...(input.data ? { data: input.data } : {}),
  };
}

/**
 * Add an event to a batch or transaction that also makes the change, so the
 * two commit together or not at all. For the endpoints that change the
 * document record, which cannot carry a trigger: every view heartbeat writes it.
 */
export function addEvent(writer: Writer, docRef: DocRef, input: EventInput): void {
  writer.create(docRef.collection("events").doc(), eventRecord(input));
}

/**
 * Record what a trigger saw, idempotently.
 *
 * Each event's id is the CloudEvent's, so a redelivery finds it there and
 * writes nothing. ALREADY_EXISTS is that case; anything else is thrown, and the
 * trigger is retried.
 */
export async function recordTriggered(
  db: Db,
  docId: string,
  eventId: string,
  events: readonly EventInput[],
): Promise<void> {
  const log = db.collection("docs").doc(docId).collection("events");
  for (const [i, e] of events.entries()) {
    try {
      await log.doc(events.length === 1 ? eventId : `${eventId}-${i}`).create(eventRecord(e));
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (code === 6 || /already exists/i.test(String((err as Error).message))) continue;
      throw err;
    }
  }
}

// --- What each source records ----------------------------------------------

type Data = Record<string, unknown> | undefined;

/** A version appearing is a publish; one disappearing is a withdrawal. */
export function versionEvents(versionId: string, before: Data, after: Data): EventInput[] {
  if (!before && after) {
    return [
      {
        type: "version.published",
        audience: "readers",
        version: versionId,
        actor: eventActor(after.publishedBy as Actor | undefined),
      },
    ];
  }
  if (before && !after) {
    return [{ type: "version.withdrawn", audience: "readers", version: versionId, actor: OPERATOR }];
  }
  return [];
}

interface SuggestionData {
  state?: unknown;
  decidedBy?: Actor;
  revisions?: Array<{ actor?: Actor }>;
}

/**
 * What a change to a thread means.
 *
 * A suggestion's state leaving `pending` is its decision, and it reports as
 * that, not also as the `resolved` flip that goes with it. A deleted thread
 * records nothing: the app never deletes one, and the operator script that
 * does is withdrawing a version, which is its own event.
 */
export function annotationEvents(
  versionId: string,
  threadId: string,
  before: Data,
  after: Data,
): EventInput[] {
  if (!after) return [];
  const sAfter = after.suggestion as SuggestionData | undefined;
  if (!before) {
    return [
      {
        type: sAfter ? "suggestion.opened" : "thread.opened",
        audience: "readers",
        version: versionId,
        threadId,
        actor: eventActor(after.actor as Actor | undefined),
      },
    ];
  }
  const out: EventInput[] = [];
  const sBefore = before.suggestion as SuggestionData | undefined;
  if (sAfter) {
    const from = String(sBefore?.state ?? "pending");
    const to = String(sAfter.state ?? "pending");
    if (from === "pending" && (to === "accepted" || to === "rejected" || to === "withdrawn")) {
      out.push({
        type: `suggestion.${to}` as EventType,
        audience: "readers",
        version: versionId,
        threadId,
        actor: eventActor(sAfter.decidedBy),
      });
    }
    const was = Array.isArray(sBefore?.revisions) ? sBefore!.revisions!.length : 0;
    const now = Array.isArray(sAfter.revisions) ? sAfter.revisions.length : 0;
    if (now > was) {
      out.push({
        type: "suggestion.revised",
        audience: "readers",
        version: versionId,
        threadId,
        actor: eventActor(sAfter.revisions![now - 1]?.actor),
      });
    }
    return out;
  }
  if (before.resolved !== true && after.resolved === true) {
    out.push({
      type: "thread.resolved",
      audience: "readers",
      version: versionId,
      threadId,
      actor: eventActor(after.resolvedBy as Actor | undefined),
    });
  } else if (before.resolved === true && after.resolved !== true) {
    out.push({
      type: "thread.reopened",
      audience: "readers",
      version: versionId,
      threadId,
      actor: eventActor(after.resolvedBy as Actor | undefined),
    });
  }
  return out;
}

/**
 * A comment somebody wrote. The notes the server writes for a decision, a
 * resolve or a reopen ("Accepted.", "Resolved.") are that event already, so
 * they record nothing of their own.
 */
export function commentEvents(versionId: string, threadId: string, commentId: string, after: Data): EventInput[] {
  if (!after || after.generated === true) return [];
  return [
    {
      type: "comment.added",
      audience: "readers",
      version: versionId,
      threadId,
      commentId,
      actor: eventActor(after.actor as Actor | undefined),
    },
  ];
}

// --- The cursor -------------------------------------------------------------

/**
 * A position in one document's log: after the event `(at, id)`, or before
 * every event when `at` is null.
 *
 * Opaque to the caller, and bound to its document: one from another document,
 * a malformed one, or one of an unknown version is refused, never read as
 * "start over" or "now". It grants nothing, because every read checks access
 * again, so it is not signed.
 */
export interface Cursor {
  docId: string;
  at: Timestamp | null;
  id: string | null;
}

const CURSOR_VERSION = 1;

export function encodeCursor(c: Cursor): string {
  return Buffer.from(
    JSON.stringify({
      v: CURSOR_VERSION,
      d: c.docId,
      ...(c.at && c.id ? { s: c.at.seconds, n: c.at.nanoseconds, e: c.id } : {}),
    }),
  ).toString("base64url");
}

/** The cursor, or a sentence saying why it is not one for this document. */
export function decodeCursor(raw: string, docId: string): Cursor | { error: string } {
  let parsed: { v?: unknown; d?: unknown; s?: unknown; n?: unknown; e?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return { error: "that is not a cursor this server gave out" };
  }
  if (!parsed || typeof parsed !== "object" || parsed.v !== CURSOR_VERSION) {
    return { error: "that is not a cursor this server gave out" };
  }
  if (parsed.d !== docId) return { error: `that cursor belongs to another document, not "${docId}"` };
  if (parsed.s === undefined) {
    return parsed.n === undefined && parsed.e === undefined
      ? { docId, at: null, id: null }
      : { error: "that is not a cursor this server gave out" };
  }
  if (
    typeof parsed.s !== "number" ||
    typeof parsed.n !== "number" ||
    typeof parsed.e !== "string" ||
    !safeSegment(parsed.e) ||
    !Number.isInteger(parsed.s) ||
    !Number.isInteger(parsed.n) ||
    parsed.s < -62135596800 || parsed.s > 253402300799 ||
    parsed.n < 0 || parsed.n >= 1_000_000_000
  ) {
    return { error: "that is not a cursor this server gave out" };
  }
  return { docId, at: new Timestamp(parsed.s, parsed.n), id: parsed.e };
}

/** A cursor at the newest event already in the log: where a new reader starts. */
export async function headCursor(docRef: DocRef): Promise<Cursor> {
  const last = await docRef
    .collection("events")
    .orderBy("at", "desc")
    .orderBy(FieldPath.documentId(), "desc")
    .limit(1)
    .get();
  const doc = last.docs[0];
  const at = doc?.data()?.at;
  return doc && at instanceof Timestamp ? { docId: docRef.id, at, id: doc.id } : { docId: docRef.id, at: null, id: null };
}

/** The events after a cursor, in recorded order, one more than a page. */
export async function eventsAfter(
  docRef: DocRef,
  cursor: Cursor,
  limit: number,
): Promise<admin.firestore.QueryDocumentSnapshot[]> {
  let q = docRef.collection("events").orderBy("at", "asc").orderBy(FieldPath.documentId(), "asc");
  if (cursor.at && cursor.id) q = q.startAfter(cursor.at, cursor.id);
  return (await q.limit(limit + 1).get()).docs;
}

// --- "last": the cursor a credential was last given -------------------------

/**
 * One cursor per credential per document, for clients that keep nothing
 * between conversations. Server-only: the rules deny every client.
 */
export function savedCursorRef(db: Db, uid: string, tokenId: string, docId: string): DocRef {
  return db.collection("users").doc(uid).collection("cursors").doc(`${tokenId}~${docId}`);
}

export async function readSavedCursor(db: Db, uid: string, tokenId: string, docId: string): Promise<string | null> {
  const snap = await savedCursorRef(db, uid, tokenId, docId).get();
  const v = snap.data()?.cursor;
  return typeof v === "string" ? v : null;
}

/** Save a cursor as "last", unless it is already what is saved (a quiet poll writes nothing). */
export async function saveCursor(
  db: Db,
  uid: string,
  tokenId: string,
  docId: string,
  cursor: string,
  { onlyIfNone = false }: { onlyIfNone?: boolean } = {},
): Promise<void> {
  const ref = savedCursorRef(db, uid, tokenId, docId);
  const current = await readSavedCursor(db, uid, tokenId, docId);
  if (current === cursor || (onlyIfNone && current !== null)) return;
  await ref.set({ cursor, docId, tokenId, updatedAt: FieldValue.serverTimestamp() });
}
