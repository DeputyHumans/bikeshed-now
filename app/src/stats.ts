// SPDX-License-Identifier: Apache-2.0
// The reading-session clock (SPEC §2, §4).

/**
 * Measures ACTIVE reading time, not wall-clock: the clock runs only while the
 * tab is visible AND the reader interacted within IDLE_MS. A document left open
 * on a second monitor stops accruing time instead of quietly logging hours,
 * which is the difference between a number that means something and a number
 * that means "this tab was open".
 *
 * Every beat reports the session's ABSOLUTE accumulated milliseconds, never a
 * delta, so a retried or duplicated beat is a server-side no-op. A dropped final
 * beacon costs at most one beat interval.
 *
 * A beat with new time is also a read: it lifts the document in the reader's
 * Recent and clears "New since you read it". So a tab reports only time somebody
 * could have been reading. Hidden or idle, it stays silent, and a tab that is
 * never shown sends nothing at all.
 *
 * This module owns the clock. The viewer just calls markActive() from the
 * interaction listeners it already attaches to the document.
 */

const BEAT_MS = 60_000;
const IDLE_MS = 5 * 60_000;

/**
 * How long a tab must stay on screen before that stretch counts for anything.
 *
 * Three reasons, and all are load-bearing. Opening the wrong document and
 * closing it immediately is not a "view", so the count means something. A tab
 * opened in the background, or passed over on the way to another, is not being
 * read. And it makes the tracker inert under React StrictMode's
 * mount/unmount/remount probe in development, which would otherwise log two
 * views for every open.
 */
export const OPEN_DELAY_MS = 2_000;

export interface ViewTracker {
  /** Note interaction, in the parent or inside the document iframe. */
  markActive: () => void;
  /** Flush a final beat and detach. Safe to call more than once. */
  stop: () => void;
}

/** Post a beat. sendBeacon survives pagehide, where fetch is killed. */
function beat(
  docId: string,
  versionId: string,
  sessionId: string,
  ms: number,
  final: boolean,
  k?: string,
): void {
  // An unlisted document's key rides along: without it, the server answers a
  // link holder's view exactly as an id that does not exist (SPEC §17).
  const payload = JSON.stringify({ docId, versionId, sessionId, ms, ...(k ? { k } : {}) });

  if (final && typeof navigator !== "undefined" && navigator.sendBeacon) {
    try {
      // Carries the same-origin session cookie, so it passes the identity gate
      // exactly like a normal fetch.
      navigator.sendBeacon("/view", new Blob([payload], { type: "application/json" }));
      return;
    } catch {
      /* fall through to fetch */
    }
  }

  // Statistics are best-effort telemetry: a failed beat must never surface to
  // the reader or interrupt what they are doing.
  void fetch("/view", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
    credentials: "same-origin",
    keepalive: final,
  }).catch(() => {});
}

function newSessionId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  // Older Safari lacks randomUUID; any opaque id matching the server's pattern
  // works, and the server validates the shape because it becomes a document id.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function trackView(docId: string, versionId: string, k?: string): ViewTracker {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return { markActive: () => {}, stop: () => {} };
  }

  const sessionId = newSessionId();

  let accruedMs = 0; // banked from completed intervals
  let runningSince: number | null = null; // the interval in flight
  let lastActivity = Date.now();
  let stopped = false;
  let registered = false;
  let looking = false; // this stretch on screen has outlasted the grace period
  let sentMs = 0; // the time the server last heard
  let graceTimer: number | undefined;

  const isVisible = () => document.visibilityState === "visible";
  const isIdle = () => Date.now() - lastActivity > IDLE_MS;

  /** Bank the interval in flight and return total active milliseconds. */
  const settle = (): number => {
    if (runningSince != null) {
      accruedMs += Date.now() - runningSince;
      runningSince = null;
    }
    return accruedMs;
  };

  /** Start the clock if we should be counting, stop it if we should not. */
  const sync = () => {
    const shouldRun = isVisible() && !isIdle();
    if (shouldRun && runningSince == null) runningSince = Date.now();
    else if (!shouldRun && runningSince != null) settle();
  };

  const markActive = () => {
    lastActivity = Date.now();
    sync();
  };

  /** Tell the server the session's time, if this stretch counts and it has moved. */
  const report = (final: boolean) => {
    if (!looking) return;
    const ms =
      final ? settle() : runningSince != null ? accruedMs + (Date.now() - runningSince) : accruedMs;
    if (ms === sentMs) return;
    sentMs = ms;
    beat(docId, versionId, sessionId, ms, final, k);
  };

  /** The tab is on screen. Switching to it is the reader doing something. */
  const enter = () => {
    if (looking) return;
    markActive();
    window.clearTimeout(graceTimer);
    graceTimer = window.setTimeout(() => {
      looking = true;
      if (registered) {
        report(false);
        return;
      }
      registered = true;
      // Registers the session — and so the +1 view — well before the first
      // heartbeat, so a reader who leaves after thirty seconds is still counted.
      beat(docId, versionId, sessionId, 0, false, k);
    }, OPEN_DELAY_MS);
  };

  /** The tab has left the screen, or the document has. A glance counts for nothing. */
  const leave = () => {
    window.clearTimeout(graceTimer);
    report(true);
    looking = false;
    runningSince = null;
  };

  if (isVisible()) enter();

  const timer = window.setInterval(() => {
    if (!looking) return;
    sync();
    report(false);
  }, BEAT_MS);

  const onVisibility = () => {
    // Going hidden may precede the tab being discarded, so leave() flushes.
    if (isVisible()) enter();
    else leave();
  };
  // Going hidden is not always announced before this, and a page restored from
  // the back/forward cache carries on where it was, so this only flushes.
  const onPageHide = () => report(true);

  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onPageHide);

  return {
    markActive,
    stop() {
      if (stopped) return;
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      // Not looking means nothing is owed. A session that never registered does
      // not exist server-side, and beating now would CREATE it, turning a
      // two-second glance into a recorded view.
      leave();
    },
  };
}
