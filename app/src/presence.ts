// SPDX-License-Identifier: Apache-2.0
// Ephemeral collaboration state: peers, the edit lock, and handoff (SPEC §16).

import {
  onDisconnect,
  onValue,
  ref,
  remove,
  runTransaction,
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

/** How long a lock survives without activity, and when the holder is warned. */
export const LOCK_IDLE_MS = 5 * 60 * 1000;
export const LOCK_WARN_MS = 4 * 60 * 1000;

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

export interface EditLock {
  uid: string;
  email: string;
  since: number;
}

export interface EditRequest {
  uid: string;
  email: string;
  at: number;
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
function throttle<T>(ms: number, apply: (value: T) => void): (value: T) => void {
  let last = 0;
  let pending: T | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (value: T) => {
    const now = Date.now();
    const wait = ms - (now - last);
    if (wait <= 0) {
      last = now;
      apply(value);
      return;
    }
    pending = value;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      last = Date.now();
      if (pending !== null) apply(pending);
      pending = null;
    }, wait);
  };
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
): PresenceHandle {
  if (!rtdb) return INERT;

  const meRef = ref(rtdb, `status/${docId}/peers/${uid}`);
  const connRef = ref(rtdb, ".info/connected");
  const emailLower = email.toLowerCase();

  let mode: PresenceMode = initialMode;
  let focus: Anchor | null = null;
  let viewport: number | null = null;
  let composing: string | null = null;
  let connected = false;

  const write = () => {
    if (!connected) return;
    const payload: Record<string, unknown> = {
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
      if (next === mode) return;
      mode = next;
      write();
    },
    setFocus: pushFocus,
    setViewport: pushViewport,
    setComposing(threadId) {
      if (threadId === composing) return;
      composing = threadId;
      write();
    },
    leave() {
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
      const val = (snap.val() as Record<string, Omit<Peer, "uid" | "color">> | null) ?? {};
      cb(
        Object.entries(val)
          .filter(([uid]) => uid !== selfUid)
          .map(([uid, v]) => ({
            uid,
            email: v.email,
            name: v.name || v.email,
            mode: v.mode === "edit" ? "edit" : "view",
            focus: v.focus,
            viewport: typeof v.viewport === "number" ? v.viewport : undefined,
            composing: v.composing,
            lastChanged: typeof v.lastChanged === "number" ? v.lastChanged : 0,
            color: peerColor(v.email),
          })),
      );
    },
    () => cb([]),
  );
}

// --- The edit lock ---------------------------------------------------------

/**
 * Why a lock at all
 * -----------------
 * Showing live cursors without one would actively invite the single thing
 * last-writer-wins handles badly: two people typing in the same paragraph. The
 * lock is what makes "no CRDT" an honest position rather than a gap.
 *
 * It is SOFT. A peer who does not hold it enters observe mode — watching the
 * draft, seeing the holder's caret, still able to highlight and comment.
 * Review does not stop because somebody is typing.
 */

export function watchLock(docId: string, cb: (lock: EditLock | null) => void): () => void {
  if (!rtdb) {
    cb(null);
    return () => {};
  }
  return onValue(
    ref(rtdb, `status/${docId}/lock`),
    (snap) => cb((snap.val() as EditLock | null) ?? null),
    () => cb(null),
  );
}

/**
 * Claim the lock, or fail because somebody else holds it.
 *
 * A transaction rather than a plain set, so two people clicking Edit in the
 * same second cannot both believe they won. A lock older than LOCK_IDLE_MS is
 * stealable: the holder's tab may have died in a way `onDisconnect` could not
 * observe, and a permanently wedged document is worse than a rare stolen lock.
 */
export async function claimLock(
  docId: string,
  uid: string,
  email: string,
): Promise<boolean> {
  if (!rtdb) return true; // no RTDB means no peers to conflict with
  const lockRef = ref(rtdb, `status/${docId}/lock`);
  try {
    const result = await runTransaction(lockRef, (current: EditLock | null) => {
      if (current && current.uid !== uid && Date.now() - current.since < LOCK_IDLE_MS) {
        return undefined; // abort: somebody else holds a live lock
      }
      return { uid, email: email.toLowerCase(), since: serverTimestamp() };
    });
    if (result.committed) {
      void onDisconnect(lockRef).remove().catch(() => {});
    }
    return result.committed;
  } catch {
    return false;
  }
}

export async function releaseLock(docId: string, uid: string): Promise<void> {
  if (!rtdb) return;
  const lockRef = ref(rtdb, `status/${docId}/lock`);
  try {
    await runTransaction(lockRef, (current: EditLock | null) =>
      current && current.uid !== uid ? undefined : null,
    );
  } catch {
    /* a failed release is corrected by onDisconnect or the idle window */
  }
}

/** Re-stamp the lock so it does not idle out while somebody is actually typing. */
export async function touchLock(
  docId: string,
  uid: string,
  email: string,
): Promise<void> {
  if (!rtdb) return;
  await claimLock(docId, uid, email);
}

// --- "Ask to edit" ---------------------------------------------------------

/**
 * Asked ONCE.
 *
 * The request is a single node keyed by the asker, so asking twice overwrites
 * rather than accumulating, and the holder dismissing it removes it. Nobody
 * gets nagged, and nobody has to build a queue to prevent nagging.
 */
export async function requestEdit(
  docId: string,
  uid: string,
  email: string,
): Promise<void> {
  if (!rtdb) return;
  try {
    await set(ref(rtdb, `status/${docId}/requests/${uid}`), {
      email: email.toLowerCase(),
      at: serverTimestamp(),
    });
  } catch {
    /* best-effort */
  }
}

export async function clearEditRequest(docId: string, uid: string): Promise<void> {
  if (!rtdb) return;
  try {
    await remove(ref(rtdb, `status/${docId}/requests/${uid}`));
  } catch {
    /* best-effort */
  }
}

export function watchEditRequests(
  docId: string,
  cb: (requests: EditRequest[]) => void,
): () => void {
  if (!rtdb) {
    cb([]);
    return () => {};
  }
  return onValue(
    ref(rtdb, `status/${docId}/requests`),
    (snap) => {
      const val = (snap.val() as Record<string, { email: string; at: number }> | null) ?? {};
      cb(Object.entries(val).map(([uid, v]) => ({ uid, email: v.email, at: v.at })));
    },
    () => cb([]),
  );
}
