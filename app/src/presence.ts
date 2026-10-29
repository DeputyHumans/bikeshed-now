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

export interface Peer {
  uid: string;
  email: string;
  name: string;
  mode: PresenceMode;
  /** Where they are looking, as an ephemeral Anchor. */
  focus?: Anchor;
  /** Fractional scroll position, 0 to 1. */
  viewport?: number;
  /** Thread id they are typing into, or "new". */
  composing?: string;
  lastChanged: number;
  /** Derived from the address, so it is the same person's colour every time. */
  color: string;
}

export interface PresenceHandle {
  setMode: (mode: PresenceMode) => void;
  setFocus: (focus: Anchor | null) => void;
  setViewport: (fraction: number) => void;
  setComposing: (threadId: string | null) => void;
  leave: () => void;
}

const INERT: PresenceHandle = {
  setMode: () => {},
  setFocus: () => {},
  setViewport: () => {},
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
  const pushViewport = throttle<number>(VIEWPORT_THROTTLE_MS, (value) => {
    viewport = value;
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
    setViewport(value) { if (!left) pushViewport.push(value); },
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
      pushViewport.cancel();
      unsubConn();
      void remove(meRef).catch(() => {});
    },
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
      for (const [session, v] of Object.entries(val)) {
        // Old clients used uid as the key. Read those during the transition;
        // new session records carry an authenticated, immutable uid instead.
        const uid = v?.uid ?? session;
        if (uid === selfUid || typeof v?.email !== "string") continue;
        const candidate: Peer = {
          uid, email: v.email, name: v.name || v.email,
          mode: v.mode === "edit" ? "edit" : "view",
          focus: v.focus,
          viewport: typeof v.viewport === "number" ? v.viewport : undefined,
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
      cb([...people.values()]);
    },
    () => cb([]),
  );
}

