// SPDX-License-Identifier: Apache-2.0
// Judge one browser's final reading beat without confusing an earlier interval or split reads with completion (SPEC §17).

/** A single-session fixture is settled only after the captured final beat is
 * reflected by both records and has a later server timestamp than registration. */
export function finalBeatSettled(stats, session, { expectedMs, previousBeatMs }) {
  const beatMs = session?.lastBeatAt?.toMillis?.();
  return Number.isFinite(expectedMs) && expectedMs > 0
    && Number.isFinite(previousBeatMs) && Number.isFinite(beatMs) && beatMs > previousBeatMs
    && session?.ms === expectedMs && stats?.totalMs === expectedMs;
}

/** Install before leaving the document. Chromium's page-exit beacons can bypass
 * Playwright request events. Observe the exact native call without replacing its
 * Blob, return value or transport; sessionStorage survives same-origin navigation. */
export function observeFinalBeacon({ docId, sessionId, key }) {
  const NativeBlob = globalThis.Blob;
  const nativeSend = navigator.sendBeacon;
  const payloads = new WeakMap();
  sessionStorage.removeItem(key);
  globalThis.Blob = new Proxy(NativeBlob, {
    construct(target, args, newTarget) {
      const blob = Reflect.construct(target, args, newTarget);
      const [parts] = args;
      if (Array.isArray(parts) && parts.every((part) => typeof part === "string")) {
        try { payloads.set(blob, JSON.parse(parts.join(""))); } catch { /* not JSON */ }
      }
      return blob;
    },
  });
  navigator.sendBeacon = function (...args) {
    const queued = Reflect.apply(nativeSend, this, args);
    const payload = payloads.get(args[1]);
    if (new URL(String(args[0]), location.href).pathname === "/view"
      && payload?.docId === docId && payload?.sessionId === sessionId) {
      const rows = JSON.parse(sessionStorage.getItem(key) ?? "[]");
      rows.push({ payload, queued });
      sessionStorage.setItem(key, JSON.stringify(rows));
    }
    return queued;
  };
}
