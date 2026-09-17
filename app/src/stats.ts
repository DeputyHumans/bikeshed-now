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
 * This module owns the clock. The viewer just calls markActive() from the
 * interaction listeners it already attaches to the document.
 */

const BEAT_MS = 60_000;
const IDLE_MS = 5 * 60_000;

/**
 * Grace period before a session is registered at all.
 *
 * Two reasons, and both are load-bearing. Opening the wrong document and
 * closing it immediately is not a "view", so the count means something. And it
 * makes the tracker inert under React StrictMode's mount/unmount/remount probe
 * in development, which would otherwise log two views for every open.
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
): void {
  const payload = JSON.stringify({ docId, versionId, sessionId, ms });

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

export function trackView(docId: string, versionId: string): ViewTracker {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return { markActive: () => {}, stop: () => {} };
  }

  const sessionId = newSessionId();

  let accruedMs = 0; // banked from completed intervals
  let runningSince: number | null = null; // the interval in flight
  let lastActivity = Date.now();
  let stopped = false;
  let registered = false;

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

  sync();

  const openTimer = window.setTimeout(() => {
    registered = true;
    // Registers the session — and so the +1 view — well before the first
    // heartbeat, so a reader who leaves after thirty seconds is still counted.
    beat(docId, versionId, sessionId, 0, false);
  }, OPEN_DELAY_MS);

  const timer = window.setInterval(() => {
    if (!registered) return;
    sync();
    const ms =
      runningSince != null ? accruedMs + (Date.now() - runningSince) : accruedMs;
    beat(docId, versionId, sessionId, ms, false);
  }, BEAT_MS);

  const onVisibility = () => {
    sync();
    // Going hidden may precede the tab being discarded, so flush what we have.
    if (!isVisible() && registered) {
      beat(docId, versionId, sessionId, settle(), true);
    }
  };
  const onPageHide = () => {
    if (stopped || !registered) return;
    beat(docId, versionId, sessionId, settle(), true);
  };

  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onPageHide);

  return {
    markActive,
    stop() {
      if (stopped) return;
      stopped = true;
      window.clearTimeout(openTimer);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      // Never registered means the session does not exist server-side. Beating
      // now would CREATE it, turning a two-second glance into a recorded view.
      if (registered) beat(docId, versionId, sessionId, settle(), true);
    },
  };
}
