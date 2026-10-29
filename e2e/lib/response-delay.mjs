// SPDX-License-Identifier: Apache-2.0
// Delay delivery of an already-answered hosting response without reordering requests (SPEC §12).

/**
 * The real request reaches hosting immediately. Only its response is held,
 * after the server finished handling it. One exact path on this user's own
 * hosting origin is intercepted; redirects are returned to the browser, whose
 * normal isolation route checks their destinations. Call restore in finally.
 */
export async function delayHostingResponse(user, path, { delayMs, method = 'POST' } = {}) {
  if (typeof path !== 'string' || !/^\/[^?#]*$/.test(path) || path.startsWith('//')) throw new Error('response delay needs an exact hosting pathname');
  if (!Number.isFinite(delayMs) || delayMs <= 0 || delayMs > 30_000) throw new Error('response delay must be in (0, 30000] ms');
  const origin = new URL(user.target.origin).origin;
  const matches = (url) => url.origin === origin && url.pathname === path;
  const rows = [];
  const waiting = new Set();
  let restored = false;
  const handle = async (route) => {
    const request = route.request();
    if (restored || request.method() !== method) return route.fallback();
    const row = { requestedAt: Date.now(), backendAnsweredAt: null, status: null, releasedAt: null, release: null, error: null };
    rows.push(row);
    let response;
    try {
      response = await route.fetch({ maxRedirects: 0, timeout: 60_000 });
      row.backendAnsweredAt = Date.now(); row.status = response.status();
      if (!restored) await new Promise((resolve) => {
        let timer;
        const release = (why) => { clearTimeout(timer); waiting.delete(release); row.release = why; resolve(); };
        const deadline = performance.now() + delayMs;
        const elapsed = () => {
          const remaining = deadline - performance.now();
          if (remaining > 0) timer = setTimeout(elapsed, Math.ceil(remaining));
          else release('delay');
        };
        waiting.add(release); timer = setTimeout(elapsed, delayMs);
      });
      row.release ??= 'restore'; row.releasedAt = Date.now();
      await route.fulfill({ response });
    } catch (error) {
      row.error = String(error?.message ?? error);
      await route.abort('failed').catch(() => undefined);
    } finally { await response?.dispose(); }
  };
  const pending = new Set();
  const handler = (route) => {
    const task = handle(route); pending.add(task);
    task.then(() => pending.delete(task), () => pending.delete(task));
    return task;
  };
  await user.page.route(matches, handler);
  return { rows, async restore() {
    restored = true;
    for (const release of [...waiting]) release('restore');
    // Removing a still-active route can make Chromium resend its request.
    // Deliver every completed response before taking the interception away.
    await Promise.allSettled([...pending]);
    await user.page.unroute(matches, handler);
    return rows;
  } };
}
