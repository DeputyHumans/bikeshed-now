// SPDX-License-Identifier: Apache-2.0
// A document's change log in words, for an agent's get_changes and a person's Activity panel alike (SPEC §17, §19, ADR 0016, ADR 0023).

import * as admin from "firebase-admin";
import { FieldPath, Timestamp } from "firebase-admin/firestore";
import type { Principal } from "./auth";
import { filedIn } from "./audience";
import { canManageSharing } from "./acl";
import type { EventActor } from "./events";
import type { VersionOrigin } from "./versions";

type Db = admin.firestore.Firestore;
type DocRef = admin.firestore.DocumentReference;
type Snapshot = admin.firestore.QueryDocumentSnapshot;
type Read = (path: string) => Promise<admin.firestore.DocumentSnapshot>;

/**
 * One renderer, two readers
 * -------------------------
 * The log stores no address and no body (lib/events.ts); both are joined here,
 * from the records they came from, when the log is read. get_changes did that
 * inline, and the Activity panel needs exactly the same words. Two copies would
 * be how an agent and a person come to disagree about who did something.
 *
 * Every event says what acted, as well as who: `channel`, `via` (the credential
 * in words, stored when it acted) and `automated`, so "a person in the browser
 * or something on their behalf" is never a guess (SPEC §17).
 */

/** One read per path for the length of a request. */
export function memo<T>(fn: (key: string) => Promise<T>): (key: string) => Promise<T> {
  const seen = new Map<string, Promise<T>>();
  return (key) => {
    if (!seen.has(key)) seen.set(key, fn(key));
    return seen.get(key)!;
  };
}

/** A memoised document reader, shared between the renderer and its caller. */
export function docReader(db: Db): Read {
  return memo((path: string) => db.doc(path).get());
}

/** How a version arrived, for one written before `origin` was stored. */
export function originOf(version: Record<string, unknown> | undefined): VersionOrigin | null {
  if (!version) return null;
  if (version.origin === "upload" || version.origin === "edit" || version.origin === "fork") return version.origin;
  if (version.publishedVia === "fork") return "fork";
  if (version.publishedVia === "editor") return "edit";
  return typeof version.publishedVia === "string" ? "upload" : null;
}

/** Each event in words, in the order given; a comment since deleted drops out. */
export async function describeEvents(
  db: Db,
  docRef: DocRef,
  caller: Principal,
  events: readonly Snapshot[],
  read: Read = docReader(db),
): Promise<Array<Record<string, unknown>>> {
  const threadPath = (version: string, threadId: string) => `docs/${docRef.id}/versions/${version}/annotations/${threadId}`;
  const emailOf = memo(async (uid: string) => String((await read(`users/${uid}`)).data()?.email ?? "") || null);
  const folderIds = events.flatMap((e) => {
    const d = e.data().data as { from?: unknown; to?: unknown } | undefined;
    return e.data().type === "doc.moved" ? [d?.from, d?.to].filter((x): x is string => typeof x === "string") : [];
  });
  const paths = await filedIn(db, caller, folderIds);

  const out: Array<Record<string, unknown>> = [];
  for (const e of events) {
    const v = e.data();
    const actor = v.actor as EventActor | undefined;
    const at = (v.at as admin.firestore.Timestamp | undefined)?.toDate?.().toISOString() ?? null;
    const item: Record<string, unknown> = {
      id: e.id,
      type: v.type,
      // A fork's time would say more than its count, and its owner is told
      // only that one was made (SPEC §21): the day, no more.
      at: v.type === "fork.created" && at ? at.slice(0, 10) : at,
      ...(actor?.channel ? { channel: actor.channel, automated: actor.channel !== "web" } : {}),
      ...(actor?.via ? { via: actor.via } : {}),
      ...(v.version ? { version: v.version } : {}),
      ...(v.threadId ? { threadId: v.threadId } : {}),
    };
    const thread = v.threadId && v.version ? (await read(threadPath(v.version, v.threadId))).data() : undefined;
    if (thread) item.quote = String((thread.anchor as { exact?: unknown } | undefined)?.exact ?? "");
    switch (v.type) {
      case "comment.added": {
        const c = (await read(`${threadPath(v.version, v.threadId)}/comments/${v.commentId}`)).data();
        if (!c) continue; // deleted by its author: gone from the feed too
        Object.assign(item, { commentId: v.commentId, by: c.authorEmail, body: c.body });
        break;
      }
      case "thread.opened":
      case "suggestion.opened":
        item.by = thread?.authorEmail ?? null;
        if (thread?.suggestion) item.replacement = String((thread.suggestion as { replacement?: unknown }).replacement ?? "");
        break;
      case "thread.resolved":
      case "thread.reopened":
        item.by = (thread?.resolvedBy as { email?: unknown } | undefined)?.email ?? null;
        break;
      case "suggestion.accepted":
      case "suggestion.rejected":
      case "suggestion.withdrawn":
        item.by = (thread?.suggestion as { decidedBy?: { email?: unknown } } | undefined)?.decidedBy?.email ?? null;
        break;
      case "suggestion.revised": {
        const s = thread?.suggestion as { replacement?: unknown; revisions?: Array<{ actor?: { email?: unknown } }> } | undefined;
        item.by = s?.revisions?.[s.revisions.length - 1]?.actor?.email ?? null;
        item.replacement = String(s?.replacement ?? "");
        break;
      }
      case "version.published": {
        const version = (await read(`docs/${docRef.id}/versions/${v.version}`)).data();
        item.by = version?.publishedByEmail ?? null;
        const origin = originOf(version);
        if (origin) item.origin = origin;
        break;
      }
      case "version.withdrawn":
        break;
      case "doc.moved": {
        const d = (v.data ?? {}) as { from?: string | null; to?: string | null };
        item.from = d.from ? paths.get(d.from) ?? { id: d.from, path: "…" } : null;
        item.to = d.to ? paths.get(d.to) ?? { id: d.to, path: "…" } : null;
        item.by = actor?.uid ? await emailOf(actor.uid) : null;
        break;
      }
      case "fork.created":
        break;
      default:
        Object.assign(item, v.data ?? {});
        item.by = actor?.uid ? await emailOf(actor.uid) : null;
    }
    out.push(item);
  }
  return out;
}

// --- The Activity panel's feed ------------------------------------------------

/** Rows per page of the Activity feed. */
export const ACTIVITY_PAGE = 50;

/** A position in each of the two sources the feed merges: [seconds, nanoseconds, id]. */
type Position = [number, number, string];
interface FeedCursor {
  e?: Position;
  v?: Position;
}

export function encodeFeedCursor(c: FeedCursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

/** A cursor this feed handed out, or an error for anything else. */
export function decodeFeedCursor(raw: string): FeedCursor | { error: string } {
  if (!raw) return {};
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Record<string, unknown>;
    const ok = (p: unknown) =>
      p === undefined ||
      (Array.isArray(p) && p.length === 3 && Number.isSafeInteger(p[0]) && Number.isSafeInteger(p[1]) && typeof p[2] === "string" && p[2].length <= 1500);
    if (!c || typeof c !== "object" || !ok(c.e) || !ok(c.v)) return { error: "not a cursor this feed gave out" };
    return { e: c.e as Position | undefined, v: c.v as Position | undefined };
  } catch {
    return { error: "not a cursor this feed gave out" };
  }
}

const positionOf = (t: Timestamp, id: string): Position => [t.seconds, t.nanoseconds, id];
const timeOf = (t: unknown): Timestamp | null => (t instanceof Timestamp ? t : null);

/** A reading session in the feed's words: who, through what, which version, how long. */
function describeRead(s: Snapshot): Record<string, unknown> {
  const v = s.data();
  const actor = v.actor as { channel?: string; via?: string } | undefined;
  const channel = actor?.channel ?? "web";
  return {
    id: `read:${s.id}`,
    type: "read",
    at: timeOf(v.startedAt)?.toDate().toISOString() ?? null,
    by: typeof v.email === "string" ? v.email : null,
    channel,
    automated: v.automated === true || channel !== "web",
    ...(actor?.via ? { via: actor.via } : {}),
    ...(typeof v.versionId === "string" ? { version: v.versionId } : {}),
    ms: typeof v.ms === "number" ? v.ms : 0,
    ...(typeof v.reads === "number" ? { reads: v.reads } : {}),
  };
}

/**
 * One page of everything that happened to a document, newest first: its change
 * log and its reading sessions, merged by time.
 *
 * Each source is read from its own exact position, so a page boundary between
 * two rows of the same millisecond neither repeats nor skips one. The caller
 * has already decided the reader may see a document's activity at all.
 */
export async function activityPage(
  db: Db,
  docRef: DocRef,
  doc: Record<string, unknown>,
  caller: Principal,
  cursor: FeedCursor,
): Promise<{ items: Array<Record<string, unknown>>; next: string | null }> {
  let events = docRef.collection("events").orderBy("at", "desc").orderBy(FieldPath.documentId(), "desc");
  if (cursor.e) events = events.startAfter(new Timestamp(cursor.e[0], cursor.e[1]), cursor.e[2]);
  let views = docRef.collection("views").orderBy("startedAt", "desc").orderBy(FieldPath.documentId(), "desc");
  if (cursor.v) views = views.startAfter(new Timestamp(cursor.v[0], cursor.v[1]), cursor.v[2]);
  const [e, v] = await Promise.all([events.limit(ACTIVITY_PAGE).get(), views.limit(ACTIVITY_PAGE).get()]);

  // Both sources in one order, newest first, and walked until a page of rows
  // the caller may see is full. Whatever was not walked is read again next
  // time, from where each source's walk stopped.
  const merged = [
    ...e.docs.map((s) => ({ kind: "e" as const, s, t: timeOf(s.data().at) })),
    ...v.docs.map((s) => ({ kind: "v" as const, s, t: timeOf(s.data().startedAt) })),
  ]
    .filter((x): x is { kind: "e" | "v"; s: Snapshot; t: Timestamp } => x.t !== null)
    .sort((a, b) => b.t.seconds - a.t.seconds || b.t.nanoseconds - a.t.nanoseconds || (a.s.id < b.s.id ? 1 : -1));

  // The caller is an editor (the gate is the caller's), so the one event they
  // may not see is the owner's alone: that a fork was made (SPEC §21).
  const owner = canManageSharing(doc as Parameters<typeof canManageSharing>[0], caller.emailLower);
  const hidden = (x: (typeof merged)[number]) => x.kind === "e" && x.s.data().audience === "owner" && !owner;
  const walked: typeof merged = [];
  let shown = 0;
  for (const x of merged) {
    if (shown >= ACTIVITY_PAGE) break;
    walked.push(x);
    if (!hidden(x)) shown++;
  }

  const eventDocs = walked.filter((x) => x.kind === "e" && !hidden(x)).map((x) => x.s);
  const described = new Map((await describeEvents(db, docRef, caller, eventDocs)).map((d) => [d.id, d]));
  const items: Array<Record<string, unknown>> = [];
  for (const x of walked) {
    if (x.kind === "v") items.push(describeRead(x.s));
    else if (described.has(x.s.id)) items.push(described.get(x.s.id)!);
  }

  const lastOf = (kind: "e" | "v") => [...walked].reverse().find((x) => x.kind === kind);
  const more = walked.length < merged.length || e.size === ACTIVITY_PAGE || v.size === ACTIVITY_PAGE;
  const le = lastOf("e");
  const lv = lastOf("v");
  const next: FeedCursor = {
    ...(le ? { e: positionOf(le.t, le.s.id) } : cursor.e ? { e: cursor.e } : {}),
    ...(lv ? { v: positionOf(lv.t, lv.s.id) } : cursor.v ? { v: cursor.v } : {}),
  };
  return { items, next: more ? encodeFeedCursor(next) : null };
}
