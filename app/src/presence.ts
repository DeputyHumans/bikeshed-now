// SPDX-License-Identifier: Apache-2.0
// Ephemeral, session-owned peer state and per-person aggregation (SPEC §16).

import {
  onDisconnect,
  onValue,
  ref,
  remove,
  serverTimestamp,
  set,
} from "firebase/database";

import { rtdb } from "./firebase";
import { peerColor } from "./brand/tokens";
import type { Anchor } from "./types";

/**
 * Presence is NOT content. It lives only in the Realtime Database, so
 * `onDisconnect` drops a person the instant their tab closes or crashes, and
 * everything here is a no-op when RTDB is unconfigured — peer cursors are a
 * feature, not a dependency.
 *
 * Reads are gated by a SERVER-MAINTAINED MIRROR of each document's member list
 * (`presenceAccess`), not by the identity gate. That matters more now than it
 * did when presence was only a name: `focus` carries a live selection, which
 * reveals what a person is reading sentence by sentence.
 *
 * Throttles are the other half of making that affordable. They are stated here
 * as constants rather than buried in a call site, because the numbers ARE the
 * design: the pointer has to feel live, the text does not.
 */

export const FOCUS_THROTTLE_MS = 200;
export const VIEWPORT_THROTTLE_MS = 500;

export type PresenceMode = "view" | "edit";

/**
 * Where the top of a reader's screen is, as a place in the TEXT rather than a
 * fraction of the page: `a` is the last element with an id at or above the top
 * of their screen, `b` the next one below it, and `at` how far the top is
 * between the two, 0 to 1. A screen of another width lays the same text out
 * taller or shorter, but `a` and `b` move with it, so a follower lands in the
 * same stretch of words. No `a` means the start of the document, no `b` its
 * end; one of the two is always there (`annotation/peers.ts` `readingPlace`).
 */
export interface ReadingPlace {
  a?: string;
  b?: string;
  at: number;
}

/** What a scroll broadcasts, read when the throttle sends it rather than on every scroll. */
export interface ViewReading {
  viewport: number;
  place: ReadingPlace | null;
}

/** The longest id a place may name, as the database rules allow. */
export const PLACE_ID_MAX = 200;
/** The highest slide index the rules allow. */
export const SLIDE_MAX = 9999;
/** The longest uid the rules allow in `following`: Firebase's own limit. */
export const UID_MAX = 128;

export interface Peer {
  uid: string;
  email: string;
  name: string;
  mode: PresenceMode;
  /** Where they are looking, as an ephemeral Anchor. */
  focus?: Anchor;
  /** Fractional scroll position, 0 to 1. The fallback for a follower. */
  viewport?: number;
  /** Where in the text the top of their screen is, when the document has ids. */
  place?: ReadingPlace;
  /** Which slide they are on, 0-based, while their deck is paged. */
  slide?: number;
  /** Thread id they are typing into, or "new". */
  composing?: string;
  /** They are following the reader of this list, in any of their tabs. */
  followsYou?: true;
  lastChanged: number;
  /** Derived from the address, so it is the same person's colour every time. */
  color: string;
}

export interface PresenceHandle {
  setMode: (mode: PresenceMode) => void;
  setFocus: (focus: Anchor | null) => void;
  /** Throttled: `read` is called once per window, when the write is sent. */
  setView: (read: () => ViewReading) => void;
  /** Sent at once when it changes; null when this reader's document is not paged. */
  setSlide: (slide: number | null) => void;
  /** Sent at once when it changes: whom this tab follows, so that person can see it. */
  setFollowing: (uid: string | null) => void;
  setComposing: (threadId: string | null) => void;
  leave: () => void;
}

const INERT: PresenceHandle = {
  setMode: () => {},
  setFocus: () => {},
  setView: () => {},
  setSlide: () => {},
  setFollowing: () => {},
  setComposing: () => {},
  leave: () => {},
};

/** Trailing-edge throttle: the LAST value in a window is the one that matters. */
function throttle<T>(ms: number, apply: (value: T) => void) {
  let last = 0;
  let pending: T;
  let hasPending = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const push = (value: T) => {
    const now = Date.now();
    const wait = ms - (now - last);
    if (wait <= 0) {
      if (timer) clearTimeout(timer);
      timer = null;
      hasPending = false;
      last = now;
      apply(value);
      return;
    }
    pending = value;
    hasPending = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      last = Date.now();
      if (hasPending) apply(pending);
      hasPending = false;
    }, wait);
  };
  return { push, cancel() { if (timer) clearTimeout(timer); timer = null; hasPending = false; } };
}

/**
 * Announce this person and keep it live.
 *
 * The `onDisconnect` handler is re-armed on every reconnect, not just at join:
 * a handler registered once is lost when the connection drops and returns,
 * which is precisely the case it exists for.
 */
export function joinPresence(
  docId: string,
  uid: string,
  email: string,
  name: string,
  initialMode: PresenceMode,
  liveEpoch = "initial",
): PresenceHandle {
  if (!rtdb) return INERT;

  // A tab owns one record. Another tab of the same person must neither
  // replace its mode nor remove it through its own onDisconnect handler.
  const sessionId = crypto.randomUUID();
  const meRef = ref(rtdb, `status/${docId}/peers/${sessionId}`);
  const connRef = ref(rtdb, ".info/connected");
  const emailLower = email.toLowerCase();

  let mode: PresenceMode = initialMode;
  let focus: Anchor | null = null;
  let viewport: number | null = null;
  let place: ReadingPlace | null = null;
  let slide: number | null = null;
  let following: string | null = null;
  let composing: string | null = null;
  let connected = false;
  let left = false;

  const write = () => {
    if (left || !connected) return;
    const payload: Record<string, unknown> = {
      uid,
      liveEpoch,
      email: emailLower,
      name: name.slice(0, 120),
      mode,
      lastChanged: serverTimestamp(),
    };
    // Only the anchor fields the rules validate, and nothing else: the schema
    // there rejects an unknown key outright, so a stray field fails the write.
    if (focus) {
      payload.focus = {
        elementId: focus.elementId.slice(0, 200),
        exact: focus.exact.slice(0, 600),
        prefix: focus.prefix.slice(0, 200),
        suffix: focus.suffix.slice(0, 200),
        start: focus.start,
        end: focus.end,
      };
    }
    if (viewport != null) payload.viewport = Math.min(1, Math.max(0, viewport));
    const shared = sharedPlace(place);
    if (shared) payload.place = shared;
    if (slide != null) payload.slide = slide;
    if (following) payload.following = following;
    if (composing) payload.composing = composing.slice(0, 200);
    void set(meRef, payload).catch(() => {
      /* presence is best-effort; a rejected write must not surface */
    });
  };

  const unsubConn = onValue(connRef, (snap) => {
    if (left) return;
    connected = snap.val() === true;
    if (!connected) return;
    void onDisconnect(meRef).remove().then(write).catch(() => {});
  });

  const pushFocus = throttle<Anchor | null>(FOCUS_THROTTLE_MS, (value) => {
    focus = value;
    write();
  });
  const pushView = throttle<() => ViewReading>(VIEWPORT_THROTTLE_MS, (read) => {
    const reading = read();
    viewport = reading.viewport;
    place = reading.place;
    write();
  });

  return {
    setMode(next) {
      // Edge-triggered: a mode change is rare and always worth sending.
      if (left || next === mode) return;
      mode = next;
      write();
    },
    setFocus(value) { if (!left) pushFocus.push(value); },
    setView(read) { if (!left) pushView.push(read); },
    setSlide(value) {
      const next = value != null && Number.isInteger(value) && value >= 0 && value <= SLIDE_MAX ? value : null;
      if (left || next === slide) return;
      slide = next;
      write();
    },
    setFollowing(value) {
      // The rules refuse one's own uid and anything longer than a uid, and a
      // refused write would drop the whole record, so neither is sent.
      const next = typeof value === "string" && value.length > 0 && value.length <= UID_MAX && value !== uid ? value : null;
      if (left || next === following) return;
      following = next;
      write();
    },
    setComposing(threadId) {
      if (left || threadId === composing) return;
      composing = threadId;
      write();
    },
    leave() {
      if (left) return;
      left = true;
      connected = false;
      pushFocus.cancel();
      pushView.cancel();
      unsubConn();
      void remove(meRef).catch(() => {});
    },
  };
}

/**
 * A place as the rules accept it, or null: ids of at most `PLACE_ID_MAX`
 * characters, at least one of them, and `at` within 0 to 1. Used both ways, so
 * a place this tab cannot send is never written (the rules would refuse the
 * whole record) and a malformed one read from a peer is never followed.
 */
function sharedPlace(value: unknown): ReadingPlace | null {
  if (!value || typeof value !== "object") return null;
  const { a, b, at } = value as Record<string, unknown>;
  const ok = (id: unknown) => typeof id === "string" && id.length > 0 && id.length <= PLACE_ID_MAX;
  if (typeof at !== "number" || !Number.isFinite(at) || (a !== undefined && !ok(a)) || (b !== undefined && !ok(b))) return null;
  if (a === undefined && b === undefined) return null;
  return {
    ...(a !== undefined ? { a: a as string } : {}),
    ...(b !== undefined ? { b: b as string } : {}),
    at: Math.min(1, Math.max(0, at)),
  };
}

/** Subscribe to everyone present. Returns an unsubscribe function. */
export function watchPeers(
  docId: string,
  selfUid: string,
  cb: (peers: Peer[]) => void,
): () => void {
  if (!rtdb) {
    cb([]);
    return () => {};
  }
  return onValue(
    ref(rtdb, `status/${docId}/peers`),
    (snap) => {
      const val = (snap.val() as Record<string, Partial<Peer>> | null) ?? {};
      const people = new Map<string, Peer>();
      // Following is an OR across a person's tabs, like editing: the tab that
      // follows need not be the newest one.
      const followers = new Set<string>();
      for (const [session, v] of Object.entries(val)) {
        // Old clients used uid as the key. Read those during the transition;
        // new session records carry an authenticated, immutable uid instead.
        const uid = v?.uid ?? session;
        if (uid === selfUid || typeof v?.email !== "string") continue;
        if ((v as { following?: unknown }).following === selfUid) followers.add(uid);
        const candidate: Peer = {
          uid, email: v.email, name: v.name || v.email,
          mode: v.mode === "edit" ? "edit" : "view",
          focus: v.focus,
          viewport: typeof v.viewport === "number" ? v.viewport : undefined,
          place: sharedPlace(v.place) ?? undefined,
          slide: typeof v.slide === "number" && Number.isInteger(v.slide) && v.slide >= 0 ? v.slide : undefined,
          composing: v.composing,
          lastChanged: typeof v.lastChanged === "number" ? v.lastChanged : 0,
          color: peerColor(v.email),
        };
        const previous = people.get(uid);
        // Editing is an OR across tabs; choose the newest of equally active
        // sessions for focus and viewport instead of letting a reader hide it.
        if (!previous || (candidate.mode === "edit" && previous.mode !== "edit") ||
          (candidate.mode === previous.mode && candidate.lastChanged >= previous.lastChanged)) {
          people.set(uid, candidate);
        }
      }
      cb([...people.values()].map((peer) => (followers.has(peer.uid) ? { ...peer, followsYou: true as const } : peer)));
    },
    () => cb([]),
  );
}

